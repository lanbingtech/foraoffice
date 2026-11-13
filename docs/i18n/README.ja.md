<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice は [GenOffice](https://github.com/genspark-ai/genoffice) のフォークで、オープンソースの開発成果には Apache-2.0 を継続して適用します。エディターを元のホストアプリと内蔵エージェントから切り離し、外部のアプリやエージェントから組み込めるようにすることを目指しています。

> このページは翻訳された短い紹介です。詳細および最新情報は [英語の README](../../README.md) を参照してください。

## 現在の対象範囲

切り離しの作業対象は現在 Docs のみです。開発版 SDK はホストインターフェース、開いている文書を編集するランタイム、ブラウザー・Electron・Qt の例を提供します。他のエディターは GenOffice 由来のデスクトップ実装のままで、同様の切り離しは完了していません。インターフェースの存在だけでは、すべてのホストやエージェントへの対応や最終マイルストーンの受け入れを意味しません。

## 組み込みと貢献

[Docs SDK ガイド](../../apps/docs/sdk/README.md) · [アーキテクチャと互換性](../docs-sdk-integration.md) · [バージョンと配布](../docs-sdk-releases.md)

ホストは保存先、権限、システムサービスを提供し、外部エージェントはモデル、会話、タスクの実行を管理します。ファイルを操作するツールと、開いているエディターのランタイムは別のインターフェースです。デスクトップ版の機能がすべて SDK に含まれるとは限りません。

[貢献](../../CONTRIBUTING.md) · [セキュリティ](../../SECURITY.md) · [プライバシー](../../PRIVACY.md) · [ライセンス](../../LICENSE) · [帰属表示](../../NOTICE)
