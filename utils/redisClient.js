const Redis = require("ioredis");
const { redisHost, redisPort, redisClusterNodes } = require("../config/keys");

class RedisClient {
  constructor() {
    this.client = null;
    this.isCluster = false; // 클러스터 모드인지 여부
  }

  async connect() {
    if (this.client) {
      return this.client;
    }

    try {
      console.log("Connecting to Redis...");

      // 환경 변수에 따라 Redis 클라이언트 설정
      if (process.env.NODE_ENV === "production" && redisClusterNodes) {
        console.log("Using Redis Cluster for production...");
        this.client = new Redis.Cluster(redisClusterNodes, {
          redisOptions: {
            retryStrategy: (times) => {
              if (times > 5) {
                console.error(
                  "Exceeded maximum retries for Redis Cluster connection"
                );
                return null;
              }
              return Math.min(times * 100, 2000); // 100ms, 200ms, 최대 2초
            },
          },
        });
        this.isCluster = true;
      } else {
        console.log("Using single-node Redis for development...");
        this.client = new Redis({
          host: redisHost,
          port: redisPort,
          retryStrategy: (times) => {
            if (times > 5) {
              console.error("Exceeded maximum retries for Redis connection");
              return null;
            }
            return Math.min(times * 100, 2000);
          },
        });
        this.isCluster = false;
      }

      this.client.on("connect", () => {
        console.log("Redis Client Connected");
      });

      this.client.on("error", (err) => {
        console.error("Redis Client Error:", err);
      });

      return this.client;
    } catch (error) {
      console.error("Redis connection error:", error);
      throw error;
    }
  }

  pipeline() {
    if (this.isCluster) {
      return this.client.pipeline();
    }
    return this.client.pipeline(); // 단일 노드에서도 pipeline 지원
  }

  async set(key, value, options = {}) {
    try {
      await this.connect();

      const stringValue =
        typeof value === "object" ? JSON.stringify(value) : String(value);

      if (options.ttl) {
        return await this.client.set(key, stringValue, "EX", options.ttl);
      }
      return await this.client.set(key, stringValue);
    } catch (error) {
      console.error("Redis set error:", error);
      throw error;
    }
  }

  async get(key) {
    try {
      await this.connect();
      const value = await this.client.get(key);
      
      if (!value) return null;
  
      // JSON 파싱 시도
      try {
        return JSON.parse(value);
      } catch {
        // JSON이 아닐 경우 원본 문자열 반환
        return value;
      }
    } catch (error) {
      console.error('Redis get error:', error);
      throw error;
    }
  }

  async del(key) {
    try {
      await this.connect();
      return await this.client.del(key);
    } catch (error) {
      console.error("Redis del error:", error);
      throw error;
    }
  }

  async quit() {
    if (this.client) {
      try {
        await this.client.quit();
        console.log("Redis connection closed successfully");
      } catch (error) {
        console.error("Redis quit error:", error);
        throw error;
      }
    }
  }

  async expire(key, ttl) {
    try {
      await this.connect();
      return await this.client.expire(key, ttl);
    } catch (error) {
      console.error("Redis expire error:", error);
      throw error;
    }
  }

}

module.exports = new RedisClient();
