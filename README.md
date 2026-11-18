# FindImageAI – Album sự kiện tìm ảnh bằng khuôn mặt

Web album ảnh sự kiện kiểu Shotpik: khách tải lên 1 ảnh selfie, AI nhận diện khuôn mặt và lọc ra những ảnh có mặt họ trong album.

## Tính năng

**Khách xem album**
- Ảnh bìa, tên sự kiện, ngày, địa điểm, số ảnh (giao diện tối).
- Tìm ảnh bằng khuôn mặt: chọn/chụp selfie → AI so khớp → tab "Ảnh của tôi".
- Thanh chỉnh độ khớp (Chặt ↔ Rộng).
- Xem ảnh toàn màn hình (vuốt / phím mũi tên), tải ảnh gốc, tải tất cả ảnh của mình dạng .zip.
- Ảnh selfie xử lý ngay trên máy khách, không tải lên máy chủ.

**Quản trị**
- Sửa thông tin album, đặt ảnh bìa, xoá ảnh.
- Tải nhiều ảnh / cả thư mục; AI quét khuôn mặt từng ảnh trong trình duyệt và lưu vector khuôn mặt (128 chiều) cùng ảnh.

## Cấu trúc

```
index.html          Toàn bộ giao diện + logic
face-api.esm.js     @vladmandic/face-api 1.7.15 (kèm TensorFlow.js)
model/              Mô hình SSD MobileNet v1, Face Landmark 68, Face Recognition
                    (đuôi .wasm thực chất là file trọng số .bin, đổi tên để host được)
```

## Lưu ý khi chạy ngoài Claude

Bản này được viết để chạy như một artifact trên claude.ai, dùng các API của nền tảng qua `window.claude.use(...)`:

| API | Dùng cho |
|---|---|
| `db` | Lưu thông tin album và danh sách ảnh + vector khuôn mặt |
| `assets` | Lưu file ảnh (gốc, 1920px, thumbnail 720px), phục vụ tại `/_blob/<id>` |
| `user` | Kiểm tra quyền quản trị (`canEdit`) |
| `downloads` | Tải ảnh / file zip về máy |

Khi host ở nơi khác (GitHub Pages, Vercel…), các API này không có sẵn. Cần thay bằng backend riêng, ví dụ:
- `db` → Firebase Firestore / Supabase Postgres
- `assets` → Firebase Storage / Supabase Storage / S3
- `user.canEdit` → đăng nhập quản trị (Firebase Auth / Supabase Auth)
- `downloads.save` → `<a download>` thông thường

Mô hình AI (`face-api.esm.js` + `model/`) chạy hoàn toàn trên trình duyệt nên dùng lại được nguyên vẹn.

## Độ chính xác

Tốt với ảnh rõ mặt, chụp gần. Dễ sót với mặt nhỏ trong ảnh đông người, mặt nghiêng, kính râm, mũ. Hướng nâng cấp: quét chia ô độ phân giải cao, cho nhiều selfie, chuyển sang ArcFace/InsightFace hoặc AWS Rekognition.
