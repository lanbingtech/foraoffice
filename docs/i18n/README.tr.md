<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice, [GenOffice](https://github.com/genspark-ai/genoffice) projesinin bir çatallamasıdır ve açık kaynak çalışmalarında Apache-2.0 lisansını korur. Amaç, düzenleyicileri özgün ana uygulamadan ve yerleşik ajandan ayırarak başka uygulama ve ajanlarla bütünleştirmektir.

> Bu sayfa kısa bir çevrilmiş tanıtımdır. Eksiksiz ve güncel bilgiler için [İngilizce README](../../README.md) belgesine bakın.

## Mevcut kapsam

Şimdiye kadarki ayırma çalışması yalnızca Docs kapsamındadır. Geliştirme SDK’sı, ana uygulama arayüzleri, açık belgeyi canlı düzenleme çalışma zamanı ve tarayıcı, Electron ve Qt örnekleri sunar. Diğer düzenleyiciler GenOffice’den devralınan masaüstü uygulamalarıdır; aynı ayırma henüz tamamlanmamıştır. Arayüzlerin varlığı her ana uygulama ve ajanın desteklendiğini ya da son kilometre taşının kabul edildiğini göstermez.

## Bütünleştirme ve katkı

[Docs SDK kılavuzu](../../apps/docs/sdk/README.md) · [Mimari ve uyumluluk](../docs-sdk-integration.md) · [Sürümler ve dağıtım](../docs-sdk-releases.md)

Ana uygulama depolama, izinler ve sistem hizmetlerini sağlar; dış ajan modeli, konuşmayı ve görevleri yönetir. Dosya araçları ile açık düzenleyicinin çalışma zamanı ayrı arayüzlerdir. Masaüstü özellikleri SDK’ya otomatik olarak dahil değildir.

[Katkı](../../CONTRIBUTING.md) · [Güvenlik](../../SECURITY.md) · [Gizlilik](../../PRIVACY.md) · [Lisans](../../LICENSE) · [Atıflar](../../NOTICE)
