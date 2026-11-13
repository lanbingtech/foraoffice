<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice adalah fork [GenOffice](https://github.com/genspark-ai/genoffice) yang mempertahankan Apache-2.0 untuk karya sumber terbukanya. Tujuannya memisahkan editor dari aplikasi host dan agen bawaan asli agar aplikasi serta agen lain dapat mengintegrasikannya.

> Ini adalah pengantar terjemahan ringkas. Informasi lengkap dan terkini tersedia di [README bahasa Inggris](../../README.md).

## Cakupan saat ini

Pemisahan yang telah dikerjakan hanya mencakup Docs. SDK pengembangan menyediakan antarmuka host, runtime penyuntingan langsung, dan contoh untuk browser, Electron, serta Qt. Editor lainnya masih berupa implementasi desktop warisan GenOffice; pemisahan yang sama belum selesai. Keberadaan antarmuka bukan bukti dukungan untuk setiap host atau agen maupun penerimaan tonggak akhir.

## Integrasi dan kontribusi

[Panduan Docs SDK](../../apps/docs/sdk/README.md) · [Arsitektur dan kompatibilitas](../docs-sdk-integration.md) · [Versi dan distribusi](../docs-sdk-releases.md)

Host menyediakan penyimpanan, izin, dan layanan sistem; agen eksternal mengelola model, percakapan, dan tugas. Alat berbasis berkas dan runtime editor yang terbuka adalah antarmuka berbeda. Fitur desktop tidak otomatis termasuk dalam SDK.

[Kontribusi](../../CONTRIBUTING.md) · [Keamanan](../../SECURITY.md) · [Privasi](../../PRIVACY.md) · [Lisensi](../../LICENSE) · [Atribusi](../../NOTICE)
