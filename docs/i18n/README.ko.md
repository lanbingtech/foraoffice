<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice는 [GenOffice](https://github.com/genspark-ai/genoffice)의 포크이며 오픈 소스 작업에 Apache-2.0 라이선스를 유지합니다. 편집기를 원래 호스트 앱 및 내장 에이전트와 분리하여 다른 앱과 에이전트에서 통합할 수 있도록 하는 것이 목표입니다.

> 이 페이지는 간략한 번역 소개입니다. 전체 내용과 최신 정보는 [영문 README](../../README.md)를 확인하세요.

## 현재 범위

현재 분리 작업은 Docs에만 적용되었습니다. 개발용 SDK는 호스트 인터페이스, 열린 문서의 실시간 편집 런타임과 브라우저, Electron, Qt 예제를 제공합니다. 다른 편집기는 GenOffice에서 이어받은 데스크톱 구현이며 같은 분리 작업이 완료되지 않았습니다. 인터페이스가 있다는 사실만으로 모든 호스트와 에이전트를 지원하거나 최종 마일스톤이 승인되었다고 볼 수 없습니다.

## 통합과 기여

[Docs SDK 안내](../../apps/docs/sdk/README.md) · [구조와 호환성](../docs-sdk-integration.md) · [버전과 배포](../docs-sdk-releases.md)

호스트는 저장소, 권한, 시스템 서비스를 제공하고 외부 에이전트는 모델, 대화, 작업 실행을 관리합니다. 파일 기반 도구와 열린 편집기의 런타임은 서로 다른 인터페이스입니다. 데스크톱 기능이 SDK에 자동으로 포함되지는 않습니다.

[기여](../../CONTRIBUTING.md) · [보안](../../SECURITY.md) · [개인정보](../../PRIVACY.md) · [라이선스](../../LICENSE) · [저작권 및 출처](../../NOTICE)
