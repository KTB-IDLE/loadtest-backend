// backend/config/keys.js
require("dotenv").config();

// 기본 키와 솔트 (개발 환경용)
const DEFAULT_ENCRYPTION_KEY = "a".repeat(64); // 32바이트를 hex로 표현
const DEFAULT_PASSWORD_SALT = "b".repeat(32); // 16바이트를 hex로 표현

module.exports = {
  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
  passwordSalt: process.env.PASSWORD_SALT || DEFAULT_PASSWORD_SALT,

  openaiApiKey: process.env.OPENAI_API_KEY,
  vectorDbEndpoint: process.env.VECTOR_DB_ENDPOINT,
  redisClusterNodes: [
    { host: "3.38.87.118", port: 6379 }, // 마스터 1
    { host: "3.38.37.104", port: 6379 }, // 마스터 2
    { host: "43.200.132.84", port: 6379 }, // 마스터 3
    { host: "3.38.87.118", port: 6380 }, // 슬레이브 1
    { host: "3.38.37.104", port: 6380 }, // 슬레이브 2
    { host: "43.200.132.84", port: 6380 }, // 슬레이브 3
  ],
};
