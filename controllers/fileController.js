// backend/controllers/fileController.js

const File = require("../models/File");
const Message = require("../models/Message");
const Room = require("../models/Room");
const {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");

// AWS SDK v3 구성
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// 안전한 파일명 생성 함수
const generateSafeFilename = (originalFilename) => {
  const ext = path.extname(originalFilename || "").toLowerCase();
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(8).toString("hex");
  return `${timestamp}_${randomBytes}${ext}`;
};

// 파일 요청에서 파일 가져오기 함수
const getFileFromRequest = async (req) => {
  try {
    const filename = req.params.filename;
    const token = req.headers["x-auth-token"] || req.query.token;
    const sessionId = req.headers["x-session-id"] || req.query.sessionId;

    if (!filename) {
      throw new Error("Invalid filename");
    }

    if (!token || !sessionId) {
      throw new Error("Authentication required");
    }

    // S3에 파일이 존재하는지 확인
    const headParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: filename,
    };

    await s3.send(new HeadObjectCommand(headParams));

    const file = await File.findOne({ filename: filename });
    if (!file) {
      throw new Error("File not found in database");
    }

    // 파일과 연관된 메시지 조회
    const message = await Message.findOne({ file: file._id });
    if (!message) {
      throw new Error("File message not found");
    }

    // 사용자가 채팅방의 참가자인지 확인
    const room = await Room.findOne({
      _id: message.room,
      participants: req.user.id,
    });

    if (!room) {
      throw new Error("Unauthorized access");
    }

    return { file };
  } catch (error) {
    console.error("getFileFromRequest 오류:", {
      filename: req.params.filename,
      error: error.message,
    });
    throw error;
  }
};

exports.uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      console.warn("요청에 파일이 없습니다.");
      return res.status(400).json({
        success: false,
        message: "파일이 선택되지 않았습니다.",
      });
    }

    // 안전한 파일명 생성
    const safeFilename = generateSafeFilename(req.file.originalname);

    // 로그 추가: 모든 필드가 제대로 설정되는지 확인
    console.log("safeFilename:", safeFilename);
    console.log("req.file.originalname:", req.file.originalname);
    console.log("req.file.mimetype:", req.file.mimetype);
    console.log("req.file.size:", req.file.size);
    console.log("req.user.id:", req.user.id);
    console.log("S3_BUCKET_NAME:", process.env.S3_BUCKET_NAME);
    console.log("AWS_REGION:", process.env.AWS_REGION);

    // S3 업로드 파라미터 설정
    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: safeFilename,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      Metadata: {
        originalName: encodeURIComponent(req.file.originalname), // 인코딩
      },
    };

    // AWS SDK v3의 lib-storage를 사용한 업로드
    const parallelUploads3 = new Upload({
      client: s3,
      params: uploadParams,
      queueSize: 4, // 동시성
      partSize: 5 * 1024 * 1024, // 5MB 단위로 업로드
      leavePartsOnError: false, // 오류 발생 시 업로드 중단
    });

    // 업로드 진행 상황 로깅
    parallelUploads3.on("httpUploadProgress", (progress) => {
      console.log(`업로드 진행: ${progress.loaded} / ${progress.total}`);
    });

    await parallelUploads3.done();

    // MongoDB에 파일 레코드 생성
    const file = new File({
      filename: safeFilename, // S3 키
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      user: req.user.id,
      // S3 URL 저장
      path: `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${safeFilename}`,
    });

    // 저장 전 로그 추가
    console.log("파일 문서 저장 전:", {
      filename: file.filename,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      user: file.user,
      path: file.path,
    });

    // 이걸 Kafka 에 던지고 저장
    await file.save();

    res.status(200).json({
      success: true,
      message: "파일 업로드 성공",
      file: {
        _id: file._id,
        filename: file.filename,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        uploadDate: file.uploadDate,
      },
    });
  } catch (error) {
    console.error("파일 업로드 오류:", error);
    res.status(500).json({
      success: false,
      message: "파일 업로드 중 오류가 발생했습니다.",
      error: error.message,
    });
  }
};

exports.downloadFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    const getParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: file.filename,
    };

    // 파일 메타데이터 가져오기
    const headData = await s3.send(new HeadObjectCommand(getParams));

    console.log("S3 headData = ", headData);

    res.set({
      "Content-Type": headData.ContentType,
      "Content-Length": headData.ContentLength,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(
        file.originalname
      )}"`,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    const fileStream = await s3.send(new GetObjectCommand(getParams));

    // Body가 Readable 스트림인지 확인
    if (fileStream.Body instanceof Readable) {
      fileStream.Body.pipe(res);
    } else {
      // 스트림이 아닐 경우 오류 응답
      res.status(500).json({
        success: false,
        message: "파일 스트리밍 중 오류가 발생했습니다.",
      });
    }
  } catch (error) {
    handleFileError(error, res);
  }
};

exports.viewFile = async (req, res) => {
  try {
    const { file } = await getFileFromRequest(req);

    if (!file.isPreviewable()) {
      return res.status(415).json({
        success: false,
        message: "미리보기를 지원하지 않는 파일 형식입니다.",
      });
    }

    const getParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: file.filename,
    };

    // 파일 메타데이터 가져오기
    const headData = await s3.send(new HeadObjectCommand(getParams));

    res.set({
      "Content-Type": headData.ContentType,
      "Content-Disposition": `inline; filename="${encodeURIComponent(
        file.originalname
      )}"`,
      "Content-Length": headData.ContentLength,
      "Cache-Control": "public, max-age=31536000, immutable",
    });

    const fileStream = await s3.send(new GetObjectCommand(getParams));

    // Body가 Readable 스트림인지 확인
    if (fileStream.Body instanceof Readable) {
      fileStream.Body.pipe(res);
    } else {
      // 스트림이 아닐 경우 오류 응답
      res.status(500).json({
        success: false,
        message: "파일 스트리밍 중 오류가 발생했습니다.",
      });
    }
  } catch (error) {
    handleFileError(error, res);
  }
};

// 파일 삭제 함수
exports.deleteFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({
        success: false,
        message: "파일을 찾을 수 없습니다.",
      });
    }

    if (file.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "파일을 삭제할 권한이 없습니다.",
      });
    }

    const deleteParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: file.filename,
    };

    // S3에서 파일 삭제
    await s3.send(new DeleteObjectCommand(deleteParams));

    // MongoDB에서 파일 레코드 삭제
    await file.deleteOne();

    res.json({
      success: true,
      message: "파일이 삭제되었습니다.",
    });
  } catch (error) {
    console.error("파일 삭제 오류:", error);
    res.status(500).json({
      success: false,
      message: "파일 삭제 중 오류가 발생했습니다.",
      error: error.message,
    });
  }
};

// 에러 핸들링 함수
const handleFileError = (error, res) => {
  console.error("파일 작업 오류:", {
    message: error.message,
    stack: error.stack,
  });

  // 에러 상태 코드 및 메시지 매핑
  const errorResponses = {
    "Invalid filename": { status: 400, message: "잘못된 파일명입니다." },
    "Authentication required": { status: 401, message: "인증이 필요합니다." },
    "Invalid file path": { status: 400, message: "잘못된 파일 경로입니다." },
    "File not found in database": {
      status: 404,
      message: "파일을 찾을 수 없습니다.",
    },
    "File message not found": {
      status: 404,
      message: "파일 메시지를 찾을 수 없습니다.",
    },
    "Unauthorized access": {
      status: 403,
      message: "파일에 접근할 권한이 없습니다.",
    },
    ENOENT: { status: 404, message: "파일을 찾을 수 없습니다." },
  };

  const errorResponse = errorResponses[error.message] || {
    status: 500,
    message: "파일 처리 중 오류가 발생했습니다.",
  };

  res.status(errorResponse.status).json({
    success: false,
    message: errorResponse.message,
  });
};
