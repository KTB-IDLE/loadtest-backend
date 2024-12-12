const bcrypt = require('bcryptjs');
const UserService = require('../services/userService'); // UserService로 변경
const { upload } = require('../middleware/upload');
const path = require('path');
const fs = require('fs').promises;

// 프로필 조회
exports.getProfile = async (req, res) => {
  try {
    const user = await UserService.getUserById(req.user.id); // 🔄 기존 User.findById를 UserService.getUserById로 교체하여 캐싱 적용
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 조회 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 업데이트
exports.updateProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: '이름을 입력해주세요.'
      });
    }

  // 🔄 기존 User.findById를 UserService.updateUser로 변경하여 캐싱 적용
  const updatedUser = await UserService.updateUser(req.user.id, { name: name.trim() });
  if (!updatedUser) {
    return res.status(404).json({
      success: false,
      message: '사용자를 찾을 수 없습니다.'
    });
 }

 res.json({
   success: true,
   message: '프로필이 업데이트되었습니다.',
   user: {
     id: updatedUser._id,
     name: updatedUser.name,
     email: updatedUser.email,
     profileImage: updatedUser.profileImage
   }
 });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 업데이트 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 이미지 업로드
exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '이미지가 제공되지 않았습니다.'
      });
    }

    // 파일 유효성 검사
    const fileSize = req.file.size;
    const fileType = req.file.mimetype;
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (fileSize > maxSize) {
      // 업로드된 파일 삭제
      await fs.unlink(req.file.path);
      return res.status(400).json({
        success: false,
        message: '파일 크기는 5MB를 초과할 수 없습니다.'
      });
    }

    if (!fileType.startsWith('image/')) {
      // 업로드된 파일 삭제
      await fs.unlink(req.file.path);
      return res.status(400).json({
        success: false,
        message: '이미지 파일만 업로드할 수 있습니다.'
      });
    }

    // 🔄 기존 User.findById를 UserService.getUserById로 변경하여 캐싱 적용
    const user = await UserService.getUserById(req.user.id);
    if (!user) {
      // 업로드된 파일 삭제
      await fs.unlink(req.file.path);
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 기존 프로필 이미지가 있다면 삭제
    if (user.profileImage) {
      const oldImagePath = path.join(__dirname, '..', user.profileImage);
      try {
        await fs.access(oldImagePath);
        await fs.unlink(oldImagePath);
      } catch (error) {
        console.error('Old profile image delete error:', error);
      }
    }

    // 새 이미지 경로 저장
    const imageUrl = `/uploads/${req.file.filename}`;
    const updatedUser = await UserService.updateUser(req.user.id, { profileImage: imageUrl }); // 🔄 캐싱 업데이트

    res.json({
      success: true,
      message: '프로필 이미지가 업데이트되었습니다.',
      imageUrl: updatedUser.profileImage
    });

  } catch (error) {
    console.error('Profile image upload error:', error);
    // 업로드 실패 시 파일 삭제
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkError) {
        console.error('File delete error:', unlinkError);
      }
    }
    res.status(500).json({
      success: false,
      message: '이미지 업로드 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 이미지 삭제
exports.deleteProfileImage = async (req, res) => {
  try {
    const user = await UserService.getUserById(req.user.id); // 🔄 캐싱된 데이터 활용
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    if (user.profileImage) {
      const imagePath = path.join(__dirname, '..', user.profileImage);
      try {
        await fs.access(imagePath);
        await fs.unlink(imagePath);
      } catch (error) {
        console.error('Profile image delete error:', error);
      }

      await UserService.updateUser(req.user.id, { profileImage: '' }); // 🔄 캐싱 업데이트
    }

    res.json({
      success: true,
      message: '프로필 이미지가 삭제되었습니다.'
    });

  } catch (error) {
    console.error('Delete profile image error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 이미지 삭제 중 오류가 발생했습니다.'
    });
  }
};

// 회원 탈퇴
exports.deleteAccount = async (req, res) => {
  try {
    const user = await UserService.getUserById(req.user.id); // 🔄 캐싱된 데이터 활용
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 프로필 이미지가 있다면 삭제
    if (user.profileImage) {
      const imagePath = path.join(__dirname, '..', user.profileImage);
      try {
        await fs.access(imagePath);
        await fs.unlink(imagePath);
      } catch (error) {
        console.error('Profile image delete error:', error);
      }
    }

    await UserService.deleteUser(req.user.id); // 🔄 deleteUser 메서드 추가하여 최적화

    res.json({
      success: true,
      message: '회원 탈퇴가 완료되었습니다.'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: '회원 탈퇴 처리 중 오류가 발생했습니다.'
    });
  }
};

module.exports = exports;