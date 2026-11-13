<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice là một nhánh fork của [GenOffice](https://github.com/genspark-ai/genoffice), tiếp tục sử dụng Apache-2.0 cho phần công việc mã nguồn mở của mình. Mục tiêu là tách trình biên tập khỏi ứng dụng chủ và tác nhân tích hợp ban đầu để các ứng dụng và tác nhân khác có thể tích hợp.

> Đây là phần giới thiệu được dịch và rút gọn. Xem [README tiếng Anh](../../README.md) để có thông tin đầy đủ và mới nhất.

## Phạm vi hiện tại

Công việc tách thành phần hiện chỉ áp dụng cho Docs. SDK đang phát triển cung cấp giao diện ứng dụng chủ, môi trường biên tập trực tiếp và ví dụ cho trình duyệt, Electron và Qt. Các trình biên tập khác vẫn là bản triển khai máy tính để bàn kế thừa từ GenOffice; việc tách tương tự chưa hoàn tất. Có giao diện không đồng nghĩa hỗ trợ mọi ứng dụng chủ hoặc tác nhân hay đã nghiệm thu cột mốc cuối cùng.

## Tích hợp và đóng góp

[Hướng dẫn Docs SDK](../../apps/docs/sdk/README.md) · [Kiến trúc và tương thích](../docs-sdk-integration.md) · [Phiên bản và phân phối](../docs-sdk-releases.md)

Ứng dụng chủ cung cấp lưu trữ, quyền và dịch vụ hệ thống; tác nhân bên ngoài quản lý mô hình, hội thoại và tác vụ. Công cụ thao tác tệp và môi trường của trình biên tập đang mở là các giao diện khác nhau. Tính năng máy tính để bàn không tự động có trong SDK.

[Đóng góp](../../CONTRIBUTING.md) · [Bảo mật](../../SECURITY.md) · [Quyền riêng tư](../../PRIVACY.md) · [Giấy phép](../../LICENSE) · [Ghi nhận nguồn](../../NOTICE)
