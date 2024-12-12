const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const pdfParse = require("pdf-parse");
const { PassThrough } = require("stream");

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

exports.processFileForRAG = async ({ bucket, key }) => {
  try {
    if (!bucket || !key) {
      throw new Error(
        `Missing required parameters: Bucket=${bucket}, Key=${key}`
      );
    }

    console.log(`Processing file from S3: Bucket=${bucket}, Key=${key}`);

    let textContent = "";

    // S3에서 파일 가져오기
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    console.log("S3 command = ", command);
    const response = await s3Client.send(command);
    console.log("S3 response = ", response);

    // PDF 파일 처리
    if (key.endsWith(".pdf")) {
      const dataBuffer = await streamToBuffer(response.Body);
      const pdfData = await pdfParse(dataBuffer);
      textContent = pdfData.text;
    } else {
      // 텍스트 파일 처리
      const textBuffer = await streamToBuffer(response.Body);
      textContent = textBuffer.toString("utf-8");
    }

    // 텍스트를 벡터화하여 벡터 DB에 저장
    await vectorDB.storeDocument(textContent);
  } catch (error) {
    console.error("Error processing file for RAG:", error);
    throw new Error("파일 처리 중 오류가 발생했습니다.");
  }
};

// S3 스트림을 버퍼로 변환하는 유틸리티 함수
const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
