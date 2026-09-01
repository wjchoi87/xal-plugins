# xal-zai-coding-plan

[Z.ai](https://z.ai) **GLM Coding Plan** provider plugin for [Xal](https://github.com/xal-sh/xal). Uses the Coding Plan's OpenAI-compatible endpoint with your Coding Plan API key.

## 왜 Coding Plan인가

이 플러그인은 Z.ai 일반 pay-as-you-go API가 아니라 **GLM Coding Plan 구독**으로 연결합니다. Coding Plan은 일반 platform key와 호환되지 않는 **전용 API key + 전용 endpoint**를 사용하므로, endpoint는 `https://api.z.ai/api/coding/paas/v4`로 고정되어 있습니다 (일반 `https://api.z.ai/api/paas/v4`와 다릅니다).

## Install

Clone the repo, then run this plugin's installer:

```bash
git clone <your-remote>
cd xal-zai-coding-plan
./install.sh
```

설치 스크립트는 플러그인을 `$XAL_DIR/plugins/xal-zai-coding-plan` (`$XAL_DIR`은 `$XAL_HOME`, 또는 기본 `~/.xal`)에 복사하고, `config.json`의 `plugins` 배열에 `./plugins/xal-zai-coding-plan`를 추가하며 기존 항목은 유지합니다.

설치 스크립트는 `pluginConfig["zai-coding-plan"].baseUrl`을 `https://api.z.ai/api/coding/paas/v4`로 기본 설정합니다. Enter를 눌러 기본값을 쓰거나 다른 endpoint(예: 자체 프록시)를 입력하면 됩니다.

## Configure

```json
{
  "plugins": ["./plugins/xal-zai-coding-plan"],
  "pluginConfig": {
    "zai-coding-plan": {
      "baseUrl": "https://api.z.ai/api/coding/paas/v4"
    }
  }
}
```

### Context windows

Coding Plan의 `/models` 응답은 모델 ID만 포함하고 context 길이는 알려주지 않습니다. 따라서 플러그인은 [Z.AI docs](https://docs.z.ai/guides/overview/overview)(2026-09 스냅샷)와 Coding Plan 가이드(Cline 예시) 기준의 번들 테이블에서 context를 채워 넣습니다.

플러그인이 Xal에 보고하는 각 모델에 대해:

- `contextWindow` — Xal이 compaction 계산에 쓰는 context 예산. 모델 최대값을 256K로 캡한 값이 기본이라 기본적으로 예산의 80%에서 자동 compaction이 작동합니다 (`/compaction-limit`).
- `contextWindows` — 예산을 초과하는 모델에만 생기는 선택형 ladder(`256K / 400K / 600K / 800K / 최대`)로 `/context-window`를 활성화합니다. 올리면 모델 물리적 최대값까지 예산이 늘어나며, 선택은 모델별로 `config.json`에 저장됩니다.

번들 테이블 예시(모델 → 최대 context): `glm-5.3`/`glm-5.2` → 1M, `glm-5.1`/`glm-5`/`glm-4.7`/`glm-4.6` → 200K, `glm-4.5`/`glm-4.5-air` → 128K.

테이블을 조정할 수 있는 두 설정:

```json
{
  "pluginConfig": {
    "zai-coding-plan": {
      "baseUrl": "https://api.z.ai/api/coding/paas/v4",
      "modelContextWindows": {
        "glm-4.5": 131072
      },
      "defaultContextWindow": 131072
    }
  }
}
```

- `modelContextWindows`: 정확한 모델 ID → 최대 context window(tokens). 번들 테이블을 덮어씁니다. endpoint 차이나 커스텀/프라이빗 모델에 사용하세요.
- `defaultContextWindow`: 번들 테이블에 없는 모델 ID에 대한 폴백 최대값. 없으면 알 수 없는 모델은 context window가 없습니다.

## Connect

```bash
xal connect zai-coding-plan
```

프롬프트에 **GLM Coding Plan API key**를 붙여 넣으세요 (개인 플랜은 [z.ai/manage-apikey](https://z.ai/manage-apikey/apikey-list), 팀 플랜은 Team Coding Plan > My Plan 참고). 플러그인은 `/models`로 key를 검증한 뒤 저장하고, 로그에서는 redact합니다.

> 일반 Z.ai platform key가 아니라 **Coding Plan 전용 key**를 사용해야 합니다. 일반 key로는 Coding Plan 구독 할당량을 쓸 수 없습니다.

## Use

모델은 `/v1/models`에서 디스커버리됩니다. `/model refresh` 또는 `xal models zai-coding-plan`으로 카탈로그를 다시 불러온 뒤 TUI에서 모델을 고르세요:

```bash
xal
/model
```

GLM 텍스트/코딩 모델은 `/thinking` 컨트롤을 지원합니다. Coding Plan은 **이미지 입력을 지원하지 않으므로**(`imageInput: false`) 텍스트 전용입니다.

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer
- Z.ai **GLM Coding Plan** 구독
