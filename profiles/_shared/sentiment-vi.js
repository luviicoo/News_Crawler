'use strict';

/**
 * Từ điển sentiment dùng chung cho tin kinh doanh tiếng Việt. Profile nạp rồi
 * thêm từ riêng của ngành:
 *
 *   const base = require('./_shared/sentiment-vi');
 *   sentiment: { ...base, negative: [...base.negative, 'cụm riêng'] }
 *
 * Viết CÓ DẤU: so khớp giữ dấu. Chỉ dùng cụm từ hai tiếng trở lên, vì một tiếng
 * dễ khớp nhầm ("kiện" trong "sự kiện", "lỗ" trong "lỗ hổng").
 */
module.exports = {
  positive: [
    'giải thưởng', 'vinh danh', 'đạt giải', 'dẫn đầu', 'đứng đầu', 'top 10', 'top 50', 'top 100',
    'tăng trưởng', 'lợi nhuận tăng', 'doanh thu tăng', 'lãi tăng', 'báo lãi', 'lãi kỷ lục', 'kỷ lục mới',
    'xác lập kỷ lục', 'lập kỷ lục', 'kỷ lục doanh thu',
    'bứt phá', 'khởi sắc', 'khả quan', 'vượt kế hoạch', 'hoàn thành vượt', 'thành công',
    'ra mắt', 'khánh thành', 'khai trương', 'đưa vào hoạt động', 'ký kết', 'hợp tác chiến lược', 'mở rộng',
    'chinh phục', 'tiên phong', 'uy tín', 'tin dùng', 'tin tưởng', 'yêu thích', 'được đánh giá cao',
    'chất lượng cao', 'đạt chuẩn', 'chứng nhận', 'phát triển bền vững', 'trách nhiệm xã hội',
    'trao tặng', 'tặng quà', 'học bổng', 'tài trợ', 'đồng hành', 'chung tay', 'ủng hộ', 'từ thiện', 'thiện nguyện',
    'ấn tượng', 'nổi bật', 'đột phá', 'đổi mới sáng tạo', 'nâng cao chất lượng', 'hưởng lợi',
    'vô địch', 'đăng quang', 'thương hiệu mạnh', 'giá trị thương hiệu', 'thương hiệu quốc gia',
    'đảm bảo an toàn', 'đảm bảo chất lượng', 'đạt các chỉ tiêu', 'đảm bảo các chỉ tiêu', 'phù hợp hồ sơ',
  ],
  negative: [
    'vi phạm', 'xử phạt', 'bị phạt', 'phạt tiền', 'phạt hành chính', 'bị thu hồi', 'thu hồi sản phẩm', 'thu hồi lô',
    'đình chỉ', 'tạm dừng lưu hành', 'bị điều tra', 'cơ quan điều tra', 'lừa đảo', 'gian lận', 'giả mạo', 'hàng nhái',
    'kém chất lượng', 'không đạt chuẩn', 'không đạt yêu cầu', 'vượt ngưỡng', 'hết hạn sử dụng', 'quá hạn sử dụng',
    'khiếu nại', 'tố cáo', 'bị phản ánh', 'người tiêu dùng phản ánh', 'bức xúc', 'tẩy chay', 'scandal', 'bê bối',
    'sụt giảm', 'giảm mạnh', 'lợi nhuận giảm', 'doanh thu giảm', 'lãi giảm', 'thua lỗ', 'lỗ ròng', 'báo lỗ', 'lao dốc',
    'khủng hoảng', 'tranh chấp', 'khởi kiện', 'kiện tụng', 'bị kiện', 'nợ thuế', 'trốn thuế', 'sa thải',
    'cắt giảm nhân sự', 'đóng cửa nhà máy', 'thất bại', 'tiêu cực', 'gây hoang mang', 'mất uy tín',
    'quảng cáo sai', 'sai sự thật', 'thổi phồng', 'đánh lừa', 'lừa dối', 'sai phạm', 'sai luật', 'sai lệch',
    'gây tranh cãi', 'nhiễm độc', 'hoang mang', 'lùm xùm', 'chuyển hồ sơ', 'công an điều tra', 'phẫn nộ', 'quảng cáo lố',
  ],
  // Tính gấp đôi tiêu cực: an toàn sản phẩm và hình sự.
  critical: [
    'khởi tố', 'bắt giữ', 'bị bắt', 'tạm giam', 'truy tố', 'ngộ độc', 'tử vong', 'nhập viện', 'hàng giả',
    'cấm lưu hành', 'đình chỉ lưu hành',
  ],
  // Đứng trong 3 tiếng ngay trước thì cụm từ không được tính ("không vi phạm", "chống hàng giả").
  negators: [
    'không', 'chưa', 'chẳng', 'bác bỏ', 'phủ nhận', 'chống', 'ngăn chặn', 'ngăn ngừa', 'phòng tránh',
    'nói không với', 'đấu tranh với', 'quản lý chặt', 'kiểm soát chặt', 'siết chặt', 'siết', 'truy quét', 'triệt phá',
  ],
  // Có "không/chưa" nhưng không phải phủ định ("không ngừng tăng trưởng", "không ít khiếu nại").
  nonNegators: ['không chỉ', 'không những', 'không ngừng', 'không ít', 'chưa từng có', 'không thể thiếu'],
};
