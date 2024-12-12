// backend/middleware/upload.js
const multer = require("multer");
const path = require("path");

// MIME 타입과 확장자 매핑
const ALLOWED_TYPES = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4"],
  "video/webm": [".webm"],
  "video/quicktime": [".mov"],
  "audio/mpeg": [".mp3"],
  "audio/wav": [".wav"],
  "audio/ogg": [".ogg"],
  "application/pdf": [".pdf"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
};

// 파일 타입별 크기 제한 설정 (바이트 단위)
const FILE_SIZE_LIMITS = {
  image: 10 * 1024 * 1024, // 이미지: 10MB
  video: 50 * 1024 * 1024, // 동영상: 50MB
  audio: 20 * 1024 * 1024, // 오디오: 20MB
  document: 20 * 1024 * 1024, // 문서: 20MB
};

// multer의 메모리 스토리지 사용
const storage = multer.memoryStorage();

// 파일 타입 가져오기 함수
const getFileType = (mimetype) => {
  const typeMap = {
    image: "이미지",
    video: "동영상",
    audio: "오디오",
    application: "문서",
  };
  const type = mimetype.split("/")[0];
  return typeMap[type] || "파일";
};

// 파일 필터링 함수
const fileFilter = (req, file, cb) => {
  try {
    // 파일명을 UTF-8로 디코딩
    const originalname = Buffer.from(file.originalname, "binary").toString(
      "utf8"
    );

    // MIME 타입 검증
    if (!ALLOWED_TYPES[file.mimetype]) {
      const fileType = getFileType(file.mimetype);
      return cb(new Error(`지원하지 않는 ${fileType} 형식입니다.`), false);
    }

    // 파일 확장자와 MIME 타입 일치 여부 확인
    const ext = path.extname(originalname).toLowerCase();
    if (!ALLOWED_TYPES[file.mimetype].includes(ext)) {
      const fileType = getFileType(file.mimetype);
      return cb(new Error(`${fileType} 확장자가 올바르지 않습니다.`), false);
    }

    // 파일명 길이 검증 (UTF-8 바이트 기준)
    const filenameBytes = Buffer.from(originalname, "utf8").length;
    if (filenameBytes > 255) {
      return cb(new Error("파일명이 너무 깁니다."), false);
    }

    // Content-Length 헤더 검증
    const declaredSize = parseInt(req.headers["content-length"]);
    const type = file.mimetype.split("/")[0];
    const limit = FILE_SIZE_LIMITS[type] || FILE_SIZE_LIMITS.document;
    if (declaredSize > limit) {
      const limitInMB = Math.floor(limit / 1024 / 1024);
      return cb(
        new Error(
          `${getFileType(
            file.mimetype
          )} 파일은 ${limitInMB}MB를 초과할 수 없습니다.`
        ),
        false
      );
    }

    // 원본 파일명을 multer의 file 객체에 저장
    file.originalname = originalname;

    cb(null, true);
  } catch (error) {
    console.error("파일 필터링 오류:", error);
    cb(error);
  }
};

// multer 인스턴스 생성
const uploadMiddleware = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 최대 파일 크기: 50MB
    files: 1, // 한 번에 하나의 파일만 업로드 가능
  },
  fileFilter: fileFilter,
});

// 에러 핸들러 미들웨어
const errorHandler = (error, req, res, next) => {
  console.error("파일 업로드 오류:", {
    error: error.message,
    stack: error.stack,
    file: req.file,
  });

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case "LIMIT_FILE_SIZE":
        return res.status(413).json({
          success: false,
          message: "파일 크기는 50MB를 초과할 수 없습니다.",
        });
      case "LIMIT_FILE_COUNT":
        return res.status(400).json({
          success: false,
          message: "한 번에 하나의 파일만 업로드할 수 있습니다.",
        });
      case "LIMIT_UNEXPECTED_FILE":
        return res.status(400).json({
          success: false,
          message: "잘못된 형식의 파일입니다.",
        });
      default:
        return res.status(400).json({
          success: false,
          message: `파일 업로드 오류: ${error.message}`,
        });
    }
  }

  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "파일 업로드 중 오류가 발생했습니다.",
    });
  }

  next();
};

module.exports = {
  upload: uploadMiddleware,
  errorHandler,
};
