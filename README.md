# FindImageAI – Album sự kiện tìm ảnh bằng khuôn mặt

Web album ảnh sự kiện kiểu Shotpik: khách tải lên 1 ảnh selfie, AI nhận diện khuôn mặt và lọc ra những ảnh có mặt họ. Chạy **miễn phí** trên Cloudflare (Workers + R2).

## Tính năng

**Khách**
- Ảnh bìa, tên sự kiện, ngày, địa điểm, số ảnh.
- Tìm ảnh bằng khuôn mặt → tab "Ảnh của tôi", có thanh chỉnh độ khớp.
- Xem toàn màn hình (vuốt / phím mũi tên), tải từng ảnh, tải tất cả ảnh của mình dạng .zip.
- Selfie xử lý ngay trên máy khách, không gửi lên máy chủ.

**Quản trị** (link "Quản trị" cuối trang, đăng nhập bằng `ADMIN_PASSWORD`)
- Sửa thông tin album, đặt ảnh bìa, xoá ảnh.
- Tải nhiều ảnh / cả thư mục. Trình duyệt tự nén ảnh (2048px + thumbnail 720px), quét khuôn mặt, lưu lên R2.

## Cấu trúc

```
src/worker.js        API: /api/config, /api/auth, /api/index, /api/file/<p|t>/<id>.jpg
public/index.html    Giao diện
public/app.js        Logic trang
public/face-api.esm.js + public/model/   AI nhận diện khuôn mặt (@vladmandic/face-api 1.7.15)
wrangler.jsonc       Cấu hình Cloudflare (bucket R2 tên "findimageai")
```

Dữ liệu trên R2:
- `index.json` – thông tin album + danh sách ảnh + vector khuôn mặt (Int8, base64). Khách tải 1 lần rồi so khớp trên máy.
- `p/<id>.jpg` – ảnh 2048px, `t/<id>.jpg` – ảnh thu nhỏ 720px.

## Deploy lên Cloudflare

1. R2 → tạo bucket tên `findimageai`.
2. (Nên làm) Bucket → Settings → Custom Domains → gắn tên miền con, VD `anh.tenmien.com`.
3. Workers & Pages → Create → Import a repository → chọn repo này → Deploy.
4. Worker → Settings → Variables and Secrets:
   - `ADMIN_PASSWORD` (loại **Secret**): mật khẩu quản trị.
   - `PUBLIC_URL` (loại Text, tuỳ chọn): `https://anh.tenmien.com`. Không đặt thì ảnh đi qua Worker (tính vào hạn mức 100.000 lượt/ngày).
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

Tốt với ảnh rõ mặt, chụp gần. Dễ sót mặt nhỏ trong ảnh đông người, mặt nghiêng, kính râm, mũ.
