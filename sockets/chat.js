const Message = require("../models/Message");
const Room = require("../models/Room");
const User = require("../models/User");
const File = require("../models/File");
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../config/keys");
const redisClient = require("../utils/redisClient");
const SessionService = require("../services/sessionService");
const aiService = require("../services/aiService");
const userService = require("../services/userService");

const { Kafka, Partitioners } = require("kafkajs");

class UserCache {
  static USER_CACHE_PREFIX = "user:";
  static USER_SOCKET_CACHE_PREFIX = "usersocket:";
  static CACHE_TTL = 3600; // 1 hour

  static generateCacheKey(userId) {
    return `${this.USER_CACHE_PREFIX}${userId}`;
  }

  static generateUserSocketCacheKey(userId) {
    return `${this.USER_CACHE_PREFIX}${userId}`;
  }
}

module.exports = function (io) {
  // const connectedUsers = new Map();
  // const streamingSessions = new Map();
  // const userRooms = new Map();
  // 무슨 Map?
  // const messageQueues = new Map();
  // const messageLoadRetries = new Map();
  const BATCH_SIZE = 30; // 한 번에 로드할 메시지 수
  const LOAD_DELAY = 300; // 메시지 로드 딜레이 (ms)
  const MAX_RETRIES = 3; // 최대 재시도 횟수
  const MESSAGE_LOAD_TIMEOUT = 10000; // 메시지 로드 타임아웃 (10초)
  const RETRY_DELAY = 2000; // 재시도 간격 (2초)
  const DUPLICATE_LOGIN_TIMEOUT = 10000; // 중복 로그인 타임아웃 (10초)

  // 로깅 유틸리티 함수
  const logDebug = (action, data) => {
    console.debug(`[Socket.IO] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString(),
    });
  };

  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    const redisKey = `chat:${roomId}`;

    try {
      // Redis에서 메시지 로드
      let cachedMessages = await redisClient.lRange(redisKey, 0, -1);

      // 타임스탬프 필터링
      if (before) {
        cachedMessages = cachedMessages.filter(
          (msg) => new Date(msg.timestamp) < new Date(before)
        );
      }

      const hasMore = cachedMessages.length > limit;
      const resultMessages = cachedMessages.slice(0, limit);
      const sortedMessages = resultMessages.sort(
        (b, a) => new Date(a.timestamp) - new Date(b.timestamp)
      );

      if (sortedMessages.length > 0) {
        // 읽음 상태 업데이트 (Redis 버전)
        const messageIds = sortedMessages.map((msg) => msg._id);
        await redisClient.lTrim(redisKey, 0, -1); // 필요시 Redis 데이터 관리
      }

      return {
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages[0]?.timestamp || null,
      };
    } catch (error) {
      console.error(
        "Redis load messages failed, falling back to MongoDB:",
        error
      );

      // Redis 실패 시 MongoDB에서 메시지 로드
      return Promise.race([
        loadMessagesFromMongoDB(socket, roomId, before, limit),
        timeoutPromise,
      ]);
    }
  };

  const saveMessagesToCache = async (roomId, messages) => {
    const redisKey = `chat:${roomId}`;
    const pipeline = redisClient.pipeline();

    messages.forEach((msg) => {
      pipeline.lpush(redisKey, JSON.stringify(msg)); // 메시지를 리스트에 저장
    });

    pipeline.ltrim(redisKey, 0, BATCH_SIZE - 1); // 최대 BATCH_SIZE 유지
    await pipeline.exec();
  };

  const loadMessagesFromMongoDB = async (socket, roomId, before, limit) => {
    try {
      const query = { room: roomId };
      if (before) {
        query.timestamp = { $lt: new Date(before) };
      }

      const messages = await Message.find(query)
        .populate("sender", "name email profileImage")
        .populate({
          path: "file",
          select: "filename originalname mimetype size",
        })
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const sortedMessages = resultMessages.sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
      );

      // Redis에 메시지 캐싱
      await saveMessagesToCache(roomId, sortedMessages);

      return {
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages[0]?.timestamp || null,
      };
    } catch (error) {
      console.error("MongoDB load messages error:", error);
      throw error;
    }
  };

  // 재시도 로직을 포함한 메시지 로드 함수
  const loadMessagesWithRetry = async (
    socket,
    roomId,
    before,
    retryCount = 0
  ) => {
    const retryKey = `${roomId}:${socket.user.id}`;

    try {
      const currentRetriesValue = await redisClient.get(
        `messageLoadRetries:${retryKey}`
      );
      const currentRetries = currentRetriesValue
        ? parseInt(currentRetriesValue, 10)
        : 0;

      if (currentRetries >= MAX_RETRIES) {
        throw new Error("최대 재시도 횟수를 초과했습니다.");
      }

      const result = await loadMessages(socket, roomId, before);
      console.log("JIWON result = ", result);

      // 재시도 횟수 초기화
      await redisClient.del(`messageLoadRetries:${retryKey}`);
      return result;
    } catch (error) {
      const currentRetriesValue = await redisClient.get(
        `messageLoadRetries:${retryKey}`
      );
      const currentRetries = currentRetriesValue
        ? parseInt(currentRetriesValue, 10)
        : 0;

      if (currentRetries < MAX_RETRIES) {
        const newRetries = currentRetries + 1;
        // 재시도 횟수 증가
        await redisClient.set(`messageLoadRetries:${retryKey}`, newRetries);

        const delay = Math.min(
          RETRY_DELAY * Math.pow(2, currentRetries),
          10000
        );

        logDebug("retrying message load", {
          roomId,
          retryCount: newRetries,
          delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, newRetries);
      }

      // 최대 횟수 초과 시 초기화
      await redisClient.del(`messageLoadRetries:${retryKey}`);
      throw error;
    }
  };

  // 중복 로그인 처리 함수
  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      // 기존 연결에 중복 로그인 알림
      existingSocket.emit("duplicate_login", {
        type: "new_login_attempt",
        deviceInfo: newSocket.handshake.headers["user-agent"],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now(),
      });

      // 타임아웃 설정
      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            // 기존 세션 종료
            existingSocket.emit("session_ended", {
              reason: "duplicate_login",
              message: "다른 기기에서 로그인하여 현재 세션이 종료되었습니다.",
            });

            // 기존 연결 종료
            existingSocket.disconnect(true);
            resolve();
          } catch (error) {
            console.error("Error during session termination:", error);
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      console.error("Duplicate login handling error:", error);
      throw error;
    }
  };

  // 미들웨어: 소켓 연결 시 인증 처리
  // 해야할 것
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;

      if (!token || !sessionId) {
        return next(new Error("Authentication error"));
      }

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) {
        return next(new Error("Invalid token"));
      }

      // 이미 연결된 사용자인지 확인

      // const existingSocketId = connectedUsers.get(decoded.user.id);

      const existingSocketId = redisClient.get(
        UserCache.generateUserSocketCacheKey(decoded.user.id)
      );
      if (existingSocketId) {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          // 중복 로그인 처리
          await handleDuplicateLogin(existingSocket, socket);
        }
      }

      const validationResult = await SessionService.validateSession(
        decoded.user.id,
        sessionId
      );
      if (!validationResult.isValid) {
        console.error("Session validation failed:", validationResult);
        return next(new Error(validationResult.message || "Invalid session"));
      }

      const user = await User.findById(decoded.user.id);
      if (!user) {
        return next(new Error("User not found"));
      }

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage,
      };

      await SessionService.updateLastActivity(decoded.user.id);
      next();
    } catch (error) {
      console.error("Socket authentication error:", error);

      if (error.name === "TokenExpiredError") {
        return next(new Error("Token expired"));
      }

      if (error.name === "JsonWebTokenError") {
        return next(new Error("Invalid token"));
      }

      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", async (socket) => {
    logDebug("socket connected", {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name,
    });

    if (socket.user) {
      // 이전 연결이 있는지 확인

      // Cache 에서 가져오기
      let user = userService.getUserById(socket.user.id);
      console.log("user", user);

      // connectedUser Key 로 가져오기
      // jiwon123
      const previousSocketId = redisClient.get(
        UserCache.generateUserSocketCacheKey(socket.user.id)
      );

      console.log("previousSocketId = ", previousSocketId);
      // const previousSocketId = connectedUsers.get(socket.user.id);

      if (previousSocketId && previousSocketId !== socket.id) {
        const previousSocket = io.sockets.sockets.get(previousSocketId);
        if (previousSocket) {
          // 이전 연결에 중복 로그인 알림
          previousSocket.emit("duplicate_login", {
            type: "new_login_attempt",
            deviceInfo: socket.handshake.headers["user-agent"],
            ipAddress: socket.handshake.address,
            timestamp: Date.now(),
          });

          // 이전 연결 종료 처리
          setTimeout(() => {
            previousSocket.emit("session_ended", {
              reason: "duplicate_login",
              message: "다른 기기에서 로그인하여 현재 세션이 종료되었습니다.",
            });
            previousSocket.disconnect(true);
          }, DUPLICATE_LOGIN_TIMEOUT);
        }
      }

      // 새로운 연결 정보 저장
      // connectedUsers.set(socket.user.id, socket.id);
      const userSocketKey = UserCache.generateUserSocketCacheKey(
        socket.user.id
      );
      await redisClient.set(userSocketKey, socket.id);

      const value = redisClient.get(userSocketKey);
      console.log("value = ", value);
    }

    // 이전 메시지 받기
    socket.on("fetchPreviousMessages", async ({ roomId, before }) => {
      const userId = socket.user.id;
      const lockKey = `messageLoad:${roomId}:${userId}`;
      const lockExpiry = 30; // 락 만료 시간 (초)

      try {
        // Redis에서 락 획득 시도
        const isLocked = await redisClient.set(lockKey, "true", {
          NX: true,
          EX: lockExpiry,
        });

        if (!isLocked) {
          logDebug("message load skipped - already loading", {
            roomId,
            userId,
          });
          return;
        }

        // 메시지 로딩 시작 알림
        socket.emit("messageLoadStart");

        // 메시지 로딩 (이 함수는 메시지를 로드하고 필요한 처리를 수행합니다)
        const result = await loadMessagesWithRetry(socket, roomId, before);

        logDebug("previous messages loaded", {
          roomId,
          messageCount: result.messages.length,
          hasMore: result.hasMore,
          oldestTimestamp: result.oldestTimestamp,
        });

        // 로딩 완료 알림 및 결과 전송
        result.messages = result.messages
          .map((msg) => {
            try {
              return JSON.parse(msg); // JSON 문자열을 객체로 변환
            } catch (error) {
              console.error("Failed to parse message:", msg);
              return null; // 파싱 실패 시 null 반환
            }
          })
          .filter(Boolean); // null 값 제거

        socket.emit("previousMessagesLoaded", result);
      } catch (error) {
        console.error("Fetch previous messages error:", error);
        socket.emit("error", {
          type: "LOAD_ERROR",
          message:
            error.message || "이전 메시지를 불러오는 중 오류가 발생했습니다.",
        });
      } finally {
        // 락 해제 (메시지 로딩이 완료된 후 즉시 해제)
        try {
          await redisClient.del(lockKey);
          logDebug("message load lock released", { roomId, userId });
        } catch (delError) {
          console.error("Failed to release message load lock:", delError);
        }
      }
    });

    // 채팅방 입장 처리 개선
    socket.on("joinRoom", async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error("Unauthorized");
        }

        // 이미 해당 방에 참여 중인지 확인
        const currentRoom = await redisClient.get(
          `userRooms:${socket.user.id}`
        );
        if (currentRoom === roomId) {
          logDebug("already in room", {
            userId: socket.user.id,
            roomId,
          });
          socket.emit("joinRoomSuccess", { roomId });
          return;
        }

        // 기존 방에서 나가기
        if (currentRoom) {
          logDebug("leaving current room", {
            userId: socket.user.id,
            roomId: currentRoom,
          });
          socket.leave(currentRoom);

          // Redis에서 기존 방 정보 삭제
          await redisClient.del(`userRooms:${socket.user.id}`);

          socket.to(currentRoom).emit("userLeft", {
            userId: socket.user.id,
            name: socket.user.name,
          });
        }

        // 채팅방 참가 with profileImage
        const room = await Room.findByIdAndUpdate(
          roomId,
          { $addToSet: { participants: socket.user.id } },
          {
            new: true,
            runValidators: true,
          }
        ).populate("participants", "name email profileImage");

        if (!room) {
          throw new Error("채팅방을 찾을 수 없습니다.");
        }

        socket.join(roomId);
        await redisClient.set(`userRooms:${socket.user.id}`, roomId);

        // 입장 메시지 생성
        const joinMessage = new Message({
          room: roomId,
          content: `${socket.user.name}님이 입장하였습니다.`,
          type: "system",
          timestamp: new Date(),
        });

        await joinMessage.save();

        // 초기 메시지 로드
        // jiwon
        const messageLoadResult = await loadMessages(socket, roomId);
        const { messages, hasMore, oldestTimestamp } = messageLoadResult;

        // 활성 스트리밍 메시지 조회
        // const activeStreams = Array.from(streamingSessions.values())
        //   .filter((session) => session.room === roomId)
        //   .map((session) => ({
        //     _id: session.messageId,
        //     type: "ai",
        //     aiType: session.aiType,
        //     content: session.content,
        //     timestamp: session.timestamp,
        //     isStreaming: true,
        //   }));

        // Redis 기반 구현 (비효율적 키검색 예, 실 서비스에서는 SCAN 고려)
        const sessionKeys = await redisClient.scanAllKeys(
          "streamingSessions:*"
        );
        const allSessions = [];

        for (const key of sessionKeys) {
          const sessionData = await redisClient.get(key);
          if (sessionData) {
            const session =
              typeof sessionData === "string"
                ? JSON.parse(sessionData)
                : sessionData;
            allSessions.push(session);
          }
        }

        const activeStreams = allSessions
          .filter((session) => session.room === roomId)
          .map((session) => ({
            _id: session.messageId,
            type: "ai",
            aiType: session.aiType,
            content: session.content,
            timestamp: session.timestamp,
            isStreaming: true,
          }));

        // 이벤트 발송
        socket.emit("joinRoomSuccess", {
          roomId,
          participants: room.participants,
          messages,
          hasMore,
          oldestTimestamp,
          activeStreams,
        });

        io.to(roomId).emit("message", joinMessage);
        io.to(roomId).emit("participantsUpdate", room.participants);

        logDebug("user joined room", {
          userId: socket.user.id,
          roomId,
          messageCount: messages.length,
          hasMore,
        });
      } catch (error) {
        console.error("Join room error:", error);
        socket.emit("joinRoomError", {
          message: error.message || "채팅방 입장에 실패했습니다.",
        });
      }
    });

    // 메시지 전송 처리
    socket.on("chatMessage", async (messageData) => {
      try {
        if (!socket.user) {
          throw new Error("Unauthorized");
        }

        if (!messageData) {
          throw new Error("메시지 데이터가 없습니다.");
        }

        const { room, type, content, fileData } = messageData;

        if (!room) {
          throw new Error("채팅방 정보가 없습니다.");
        }

        // 채팅방 권한 확인
        const chatRoom = await Room.findOne({
          _id: room,
          participants: socket.user.id,
        });

        if (!chatRoom) {
          throw new Error("채팅방 접근 권한이 없습니다.");
        }

        // 세션 유효성 재확인
        const sessionValidation = await SessionService.validateSession(
          socket.user.id,
          socket.user.sessionId
        );

        if (!sessionValidation.isValid) {
          throw new Error("세션이 만료되었습니다. 다시 로그인해주세요.");
        }

        // AI 멘션 확인
        const aiMentions = extractAIMentions(content);

        let message;

        logDebug("message received", {
          type,
          room,
          userId: socket.user.id,
          hasFileData: !!fileData,
          hasAIMentions: aiMentions.length,
        });

        switch (type) {
          case "file":
            if (!fileData || !fileData._id) {
              throw new Error("파일 데이터가 올바르지 않습니다.");
            }

            const file = await File.findOne({
              _id: fileData._id,
              user: socket.user.id,
            });

            if (!file) {
              throw new Error("파일을 찾을 수 없거나 접근 권한이 없습니다.");
            }

            message = new Message({
              room,
              sender: socket.user.id,
              type: "file",
              file: file._id,
              content: content || "",
              timestamp: new Date(),
              reactions: {},
              metadata: {
                fileType: file.mimetype,
                fileSize: file.size,
                originalName: file.originalname,
              },
            });
            await message.save();
            await message.populate([
              { path: "sender", select: "name email profileImage" },
              { path: "file", select: "filename originalname mimetype size" },
            ]);

            break;

          case "text":
            const messageContent = content?.trim() || messageData.msg?.trim();
            if (!messageContent) {
              return;
            }

            message = new Message({
              room,
              sender: socket.user.id,
              content: messageContent,
              type: "text",
              timestamp: new Date(),
              reactions: {},
            });
            await message.save();
            await message.populate([
              { path: "sender", select: "name email profileImage" },
              { path: "file", select: "filename originalname mimetype size" },
            ]);

            break;

          default:
            throw new Error("지원하지 않는 메시지 타입입니다.");
        }

        io.to(room).emit("message", message);

        await redisClient.saveChatMessage(room, message);
        console.log("jiwon content = ", message);

        // AI 멘션이 있는 경우 AI 응답 생성
        if (aiMentions.length > 0) {
          for (const ai of aiMentions) {
            const query = content
              .replace(new RegExp(`@${ai}\\b`, "g"), "")
              .trim();
            await handleAIResponse(io, room, ai, query);
          }
        }

        await SessionService.updateLastActivity(socket.user.id);

        logDebug("message processed", {
          messageId: message._id,
          type: message.type,
          room,
        });
      } catch (error) {
        console.error("Message handling error:", error);
        socket.emit("error", {
          code: error.code || "MESSAGE_ERROR",
          message: error.message || "메시지 전송 중 오류가 발생했습니다.",
        });
      }
    });

    // 채팅방 퇴장 처리
    socket.on("leaveRoom", async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error("Unauthorized");
        }

        // 실제로 해당 방에 참여 중인지 먼저 확인
        const currentRoom = await redisClient.get(
          `userRooms:${socket.user.id}`
        );
        if (!currentRoom || currentRoom !== roomId) {
          console.log(`User ${socket.user.id} is not in room ${roomId}`);
          return;
        }

        // 권한 확인
        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id,
        })
          .select("participants")
          .lean();

        if (!room) {
          console.log(`Room ${roomId} not found or user has no access`);
          return;
        }

        socket.leave(roomId);
        await redisClient.del(`userRooms:${socket.user.id}`);

        // 퇴장 메시지 생성 및 저장
        const leaveMessage = await Message.create({
          room: roomId,
          content: `${socket.user.name}님이 퇴장하였습니다.`,
          type: "system",
          timestamp: new Date(),
        });

        // 참가자 목록 업데이트 - profileImage 포함
        const updatedRoom = await Room.findByIdAndUpdate(
          roomId,
          { $pull: { participants: socket.user.id } },
          {
            new: true,
            runValidators: true,
          }
        ).populate("participants", "name email profileImage");

        if (!updatedRoom) {
          console.log(`Room ${roomId} not found during update`);
          return;
        }

        // 스트리밍 세션 정리
        const sessionKeys = await redisClient.scanAllKeys(
          "streamingSessions:*"
        );

        for (const key of sessionKeys) {
          const sessionData = await redisClient.get(key);
          if (sessionData) {
            const session =
              typeof sessionData === "string"
                ? JSON.parse(sessionData)
                : sessionData;
            if (session.userId === socket.user.id) {
              await redisClient.del(key);
            }
          }
        }

        const retryKeys = await redisClient.get(
          `messageLoadRetries:*:${socket.user.id}`
        );
        for (const key of retryKeys) {
          await redisClient.del(key);
        }

        // 이벤트 발송
        io.to(roomId).emit("message", leaveMessage);
        io.to(roomId).emit("participantsUpdate", updatedRoom.participants);

        console.log(`User ${socket.user.id} left room ${roomId} successfully`);
      } catch (error) {
        console.error("Leave room error:", error);
        socket.emit("error", {
          message: error.message || "채팅방 퇴장 중 오류가 발생했습니다.",
        });
      }
    });

    // 연결 해제 처리
    // jiwon2
    socket.on("disconnect", async (reason) => {
      if (!socket.user) return;

      try {
        // 해당 사용자의 현재 활성 연결인 경우에만 정리

        if (
          redisClient.get(
            UserCache.generateUserSocketCacheKey(socket.user.id)
          ) === socket.id
        ) {
          redisClient.del(UserCache.generateUserSocketCacheKey(socket.user.id));
        }

        const roomId = await redisClient.get(`userRooms:${socket.user.id}`);
        await redisClient.del(`userRooms:${socket.user.id}`);

        // 스트리밍 세션 정리
        const sessionKeys = await redisClient.scanAllKeys(
          "streamingSessions:*"
        );

        for (const key of sessionKeys) {
          const sessionData = await redisClient.get(key);
          if (sessionData) {
            const session =
              typeof sessionData === "string"
                ? JSON.parse(sessionData)
                : sessionData;
            if (session.userId === socket.user.id) {
              await redisClient.del(key);
            }
          }
        }

        // 현재 방에서 자동 퇴장 처리
        if (roomId) {
          // 다른 디바이스로 인한 연결 종료가 아닌 경우에만 처리
          if (
            reason !== "client namespace disconnect" &&
            reason !== "duplicate_login"
          ) {
            const leaveMessage = await Message.create({
              room: roomId,
              content: `${socket.user.name}님이 연결이 끊어졌습니다.`,
              type: "system",
              timestamp: new Date(),
            });

            const updatedRoom = await Room.findByIdAndUpdate(
              roomId,
              { $pull: { participants: socket.user.id } },
              {
                new: true,
                runValidators: true,
              }
            ).populate("participants", "name email profileImage");

            if (updatedRoom) {
              io.to(roomId).emit("message", leaveMessage);
              io.to(roomId).emit(
                "participantsUpdate",
                updatedRoom.participants
              );
            }
          }
        }

        logDebug("user disconnected", {
          reason,
          userId: socket.user.id,
          socketId: socket.id,
          lastRoom: roomId,
        });
      } catch (error) {
        console.error("Disconnect handling error:", error);
      }
    });

    // 세션 종료 또는 로그아웃 처리
    socket.on("force_login", async ({ token }) => {
      try {
        if (!socket.user) return;

        // 강제 로그아웃을 요청한 클라이언트의 세션 정보 확인
        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error("Invalid token");
        }

        // 세션 종료 처리
        socket.emit("session_ended", {
          reason: "force_logout",
          message: "다른 기기에서 로그인하여 현재 세션이 종료되었습니다.",
        });

        // 연결 종료
        socket.disconnect(true);
      } catch (error) {
        console.error("Force login error:", error);
        socket.emit("error", {
          message: "세션 종료 중 오류가 발생했습니다.",
        });
      }
    });

    // 메시지 읽음 상태 처리
    socket.on("markMessagesAsRead", async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) {
          throw new Error("Unauthorized");
        }

        if (!Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        // 읽음 상태 업데이트
        await Message.updateMany(
          {
            _id: { $in: messageIds },
            room: roomId,
            "readers.userId": { $ne: socket.user.id },
          },
          {
            $push: {
              readers: {
                userId: socket.user.id,
                readAt: new Date(),
              },
            },
          }
        );

        socket.to(roomId).emit("messagesRead", {
          userId: socket.user.id,
          messageIds,
        });
      } catch (error) {
        console.error("Mark messages as read error:", error);
        socket.emit("error", {
          message: "읽음 상태 업데이트 중 오류가 발생했습니다.",
        });
      }
    });

    // 리액션 처리
    socket.on("messageReaction", async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error("Unauthorized");
        }

        const message = await Message.findById(messageId);
        if (!message) {
          throw new Error("메시지를 찾을 수 없습니다.");
        }

        // 리액션 추가/제거
        if (type === "add") {
          await message.addReaction(reaction, socket.user.id);
        } else if (type === "remove") {
          await message.removeReaction(reaction, socket.user.id);
        }

        // 업데이트된 리액션 정보 브로드캐스트
        io.to(message.room).emit("messageReactionUpdate", {
          messageId,
          reactions: message.reactions,
        });
      } catch (error) {
        console.error("Message reaction error:", error);
        socket.emit("error", {
          message: error.message || "리액션 처리 중 오류가 발생했습니다.",
        });
      }
    });
  });

  // AI 멘션 추출 함수
  function extractAIMentions(content) {
    if (!content) return [];

    const aiTypes = ["wayneAI", "consultingAI"];
    const mentions = new Set();
    const mentionRegex = /@(wayneAI|consultingAI)\b/g;
    let match;

    while ((match = mentionRegex.exec(content)) !== null) {
      if (aiTypes.includes(match[1])) {
        mentions.add(match[1]);
      }
    }

    return Array.from(mentions);
  }

  // AI 응답 처리 함수 개선
  async function handleAIResponse(io, room, aiName, query) {
    const messageId = `${aiName}-${Date.now()}`;
    let accumulatedContent = "";
    const timestamp = new Date();

    // 스트리밍 세션 초기화
    // Redis 기반:
    const newSession = {
      room,
      aiType: aiName,
      content: "",
      messageId,
      timestamp,
      lastUpdate: Date.now(),
      reactions: {},
    };
    await redisClient.set(`streamingSessions:${messageId}`, newSession);

    logDebug("AI response started", {
      messageId,
      aiType: aiName,
      room,
      query,
    });

    // 초기 상태 전송
    io.to(room).emit("aiMessageStart", {
      messageId,
      aiType: aiName,
      timestamp,
    });

    try {
      // AI 응답 생성 및 스트리밍
      await aiService.generateResponse(query, aiName, {
        onStart: () => {
          logDebug("AI generation started", {
            messageId,
            aiType: aiName,
          });
        },
        onChunk: async (chunk) => {
          accumulatedContent += chunk.currentChunk || "";

          const sessionData = await redisClient.get(
            `streamingSessions:${messageId}`
          );

          const session = sessionData; // 더 이상 JSON.parse를 하지 않음
          if (session) {
            session.content = accumulatedContent;
            session.lastUpdate = Date.now();
          }

          io.to(room).emit("aiMessageChunk", {
            messageId,
            currentChunk: chunk.currentChunk,
            fullContent: accumulatedContent,
            isCodeBlock: chunk.isCodeBlock,
            timestamp: new Date(),
            aiType: aiName,
            isComplete: false,
          });
        },
        onComplete: async (finalContent) => {
          // 스트리밍 세션 정리
          await redisClient.del(`streamingSessions:${messageId}`);

          // AI 메시지 저장
          const aiMessage = await Message.create({
            room,
            content: finalContent.content,
            type: "ai",
            aiType: aiName,
            timestamp: new Date(),
            reactions: {},
            metadata: {
              query,
              generationTime: Date.now() - timestamp,
              completionTokens: finalContent.completionTokens,
              totalTokens: finalContent.totalTokens,
            },
          });

          // 완료 메시지 전송
          io.to(room).emit("aiMessageComplete", {
            messageId,
            _id: aiMessage._id,
            content: finalContent.content,
            aiType: aiName,
            timestamp: new Date(),
            isComplete: true,
            query,
            reactions: {},
          });

          logDebug("AI response completed", {
            messageId,
            aiType: aiName,
            contentLength: finalContent.content.length,
            generationTime: Date.now() - timestamp,
          });
        },
        onError: (error) => {
          redisClient.del(`streamingSessions:${messageId}`);
          console.error("AI response error:", error);

          io.to(room).emit("aiMessageError", {
            messageId,
            error: error.message || "AI 응답 생성 중 오류가 발생했습니다.",
            aiType: aiName,
          });

          logDebug("AI response error", {
            messageId,
            aiType: aiName,
            error: error.message,
          });
        },
      });
    } catch (error) {
      redisClient.del(`streamingSessions:${messageId}`);
      console.error("AI service error:", error);

      io.to(room).emit("aiMessageError", {
        messageId,
        error: error.message || "AI 서비스 오류가 발생했습니다.",
        aiType: aiName,
      });

      logDebug("AI service error", {
        messageId,
        aiType: aiName,
        error: error.message,
      });
    }
  }

  return io;
};
