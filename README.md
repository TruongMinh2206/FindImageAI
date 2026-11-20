# FindImageAI – Album sự kiện tìm ảnh bằng khuôn mặt

Web album ảnh sự kiện kiểu Shotpik: khách tải lên 1 ảnh selfie, AI nhận diện khuôn mặt và lọc ra những ảnh có mặt họ. Chạy **miễn phí** trên Cloudflare (Workers + R2).

## Tính năng

**Khách**
- Ảnh bìa, tên sự kiện, ngày, địa điểm, số ảnh.
- Tìm ảnh bằng khuôn mặt → tab "Ảnh của tôi", có thanh chỉnh độ khớp.
- Xem toàn màn hình (vuốt / phím mũi tên), tải từng ảnh, tải tất cả ảnh của mình dạng .zip.
- Selfie xử lý ngay trên máy khách, không gửi lên máy chủ.

- Mục "Bạn có trong album này?": AI đã gom sẵn khuôn mặt thành từng người, khách chạm vào mặt mình là thấy ảnh.

**Quản trị** (link "Quản trị" cuối trang, đăng nhập bằng `ADMIN_PASSWORD`)
- Sửa thông tin album, gắn 2 logo, đặt ảnh bìa, xoá ảnh.
- Thêm ảnh từ máy tính (nhiều ảnh / cả thư mục) hoặc dán link thư mục Google Drive.
- Trình duyệt tự nén ảnh (2048px + thumbnail 720px), quét khuôn mặt, lưu lên R2, rồi gom nhóm khuôn mặt.

## Cấu trúc

```
src/worker.js        API: /api/config, /api/auth, /api/index, /api/file/..., /api/drive/list, /api/drive/img
public/index.html    Giao diện
public/app.js        Logic trang
public/faces.js      Bộ AI khuôn mặt: tìm mặt + điểm mốc (face-api), nhận diện bằng SFace
public/cluster.js    Gom nhóm khuôn mặt thành từng người
public/face-api.esm.js, public/model/ssd_*, face_landmark_68_*   Tìm vị trí mặt và điểm mốc (@vladmandic/face-api 1.7.15, MIT)
public/model/sface.part0.bin + part1.bin   Mô hình nhận diện SFace của OpenCV Zoo (face_recognition_sface_2021dec.onnx, Apache 2.0),
                     cắt làm 2 phần vì Cloudflare giới hạn 25 MB mỗi file; SHA-256 bản gốc 0ba9fbfa…4e79
public/ort/          onnxruntime-web 1.31.1 (MIT) để chạy SFace trong trình duyệt
wrangler.jsonc       Cấu hình Cloudflare (bucket R2 tên "findimageai")
```

Dữ liệu trên R2:
- `index.json` – thông tin album + danh sách ảnh + vector khuôn mặt (Int8, base64). Khách tải 1 lần rồi so khớp trên máy.
- `p/<id>.jpg` – ảnh 2048px, `t/<id>.jpg` – ảnh thu nhỏ 720px, `f/<...>.jpg` – ảnh đại diện từng người, `l/<id>.png` – logo.

## Deploy lên Cloudflare

1. R2 → tạo bucket tên `findimageai`.
2. (Nên làm) Bucket → Settings → Custom Domains → gắn tên miền con, VD `anh.tenmien.com`.
3. Workers & Pages → Create → Import a repository → chọn repo này → Deploy.
4. Worker → Settings → Variables and Secrets:
   - `ADMIN_PASSWORD` (loại **Secret**): mật khẩu quản trị.
   - `PUBLIC_URL` (loại Text, tuỳ chọn): `https://anh.tenmien.com`. Không đặt thì ảnh đi qua Worker (tính vào hạn mức 100.000 lượt/ngày).
   - `GOOGLE_API_KEY` (loại **Secret**, tuỳ chọn): để nhập ảnh từ Google Drive. Tạo tại console.cloud.google.com: tạo project → bật **Google Drive API** → Credentials → Create credentials → API key → giới hạn key chỉ dùng cho Google Drive API. Thư mục Drive phải để "Bất kỳ ai có đường liên kết".
5. Mở `https://findimageai.<tài-khoản>.workers.dev`, bấm "Quản trị" cuối trang để tải ảnh.

## Chạy thử trên máy

```
npm install
echo "ADMIN_PASSWORD=test123" > .dev.vars
npx wrangler dev
```

## Hạn mức miễn phí (tham khảo)

- R2: 10 GB, 1 triệu lượt ghi, 10 triệu lượt đọc mỗi tháng, không mất phí tải ra. ~0,7 MB/ảnh → khoảng 15.000 ảnh.
- Workers: 100.000 lượt gọi/ngày.

## Độ chính xác

Nhận diện dùng SFace: hai mặt cùng người thường cách nhau < 0,9; khác người thường > 1,2. Mặt dưới khoảng 30 px, mặt quay ngang hẳn bị bỏ qua. Dễ sót mặt nhỏ trong ảnh đông người, kính râm, mũ.
