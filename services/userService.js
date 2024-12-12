const redisClient = require('../utils/redisClient');
const User = require('../models/User');
const mongoose = require('mongoose');

class UserService {
  static USER_CACHE_PREFIX = 'user:';
  static CACHE_TTL = 3600; // 1 hour

  static generateCacheKey(userId) {
    return `{user}:${userId}`;
  }

  static async getUserFromCache(userId) {
    const cachedUser = await redisClient.get(this.generateCacheKey(userId));
    try {
      // Redis 데이터가 JSON 문자열인지 확인
      if (cachedUser) {
        return typeof cachedUser === 'string' ? JSON.parse(cachedUser) : cachedUser;
      }
    } catch (error) {
      console.error('Failed to parse cached user data:', cachedUser, error);
      return null;
    }
    return null;
  }

  static async saveUserToCache(user) {
    await redisClient.set(
      this.generateCacheKey(user._id), 
      JSON.stringify(user), 
      { ttl: this.CACHE_TTL });
  }

  static async saveToCache(cacheKey, data) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(data), { ttl: this.CACHE_TTL });
    } catch (err) {
      console.error('Failed to save data to cache:', err);
    }
  }

  static async getUserById(userId) {
    let user = await this.getUserFromCache(userId);
    if (!user) {
      console.log('Sunny - Cache miss for user ID:', userId);
      user = await User.findById(userId);
      if (user) {
        await this.saveUserToCache(user);
      }
    }
    return user;
  }

  static async getUserByEmail(email) {
    const cacheKey = `{user}:email:${email}`;
    let userId = await redisClient.get(cacheKey);

    if (!userId) {
        console.log('캐시 미스 - Cache miss for email: ', email);
        const user = await User.findOne({ email });

        if (user) {
            userId = user._id.toString();

            // 캐싱: userId 및 사용자 데이터를 Redis에 저장
            const pipeline = redisClient.pipeline();
            pipeline.set(cacheKey, userId, "EX", this.CACHE_TTL);
            pipeline.set(this.generateCacheKey(user._id), JSON.stringify(user), "EX", this.CACHE_TTL);
            await pipeline.exec();
        } else {
            console.warn('사용자 없음 - User not found for email: ', email);
            return null;    
        }
    }

    return userId ? await this.getUserById(userId) : null; 
  }

  static async getUserByEmailWithPassword(email) {
    const cacheKey = `{user}:email_with_password:${email}`;
    let userId = await redisClient.get(cacheKey);

    if (!userId) {
        console.log('Cache miss for email with password:', email);

        // MongoDB에서 이메일로 사용자 검색
        const user = await User.findOne({ email }).select('+password');
        if (user) {
            userId = user._id.toString();

            // 캐싱: userId 및 사용자 데이터를 Redis에 저장
            const pipeline = redisClient.pipeline(); // 클러스터, 로컬 모두 대응
            pipeline.set(cacheKey,  userId, "EX", this.CACHE_TTL);
            pipeline.set(this.generateCacheKey(user._id), JSON.stringify(user), "EX", this.CACHE_TTL);
            await pipeline.exec();
        } else {
            return null; // 사용자 없음
        }
    }
    return userId ? await this.getUserById(userId) : null;
  }

  static async createUser(data) {
    // 1. 새 사용자 생성 및 저장
    const user = new User(data);
    await user.save();

    // 2. 사용자 데이터를 캐싱
    const emailKey = `{user}:email:${user.email}`;
    const emailWithPasswordKey = `{user}:email_with_password:${user.email}`;

    // Redis 트랜잭션으로 캐싱 처리
    const pipeline = redisClient.pipeline(); // 클러스터, 로컬 모두 대응
    pipeline.set(emailKey, user._id.toString(), "EX", this.CACHE_TTL);
    pipeline.set(emailWithPasswordKey, user._id.toString(), "EX", this.CACHE_TTL);
    pipeline.set(this.generateCacheKey(user._id), JSON.stringify(user), "EX", this.CACHE_TTL);
    try {
        const results = await pipeline.exec();
        console.log('Redis 파이프라인 실행 결과:', results); // 로그 추가
      } catch (redisError) {
        console.error('Redis 파이프라인 실행 실패:', redisError);
    }

    return user;
  }

  static async updateUser(userId, updateData) {
    const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
        new: true, // 업데이트된 데이터를 반환
        lean: true, // Optimize MongoDB performance - lean()을 사용해 MongoDB의 반환값을 JavaScript 객체로 최적화.
     });
     if (updatedUser) {
        await this.clearUserCache(userId);
        await this.saveUserToCache(updatedUser);
      }
    return updatedUser;
  }

  static async clearUserCache(userId) {
    await redisClient.del(this.generateCacheKey(userId));
  }

  static async deleteUser(userId) {
    try {
      await User.deleteOne({ _id: userId });
      await this.clearUserCache(userId); // 캐시 제거
      console.log('User and cache deleted for userId:', userId);
    } catch (error) {
      console.error('Error deleting user:', error);
      throw error;
    }
  }
}

module.exports = UserService;