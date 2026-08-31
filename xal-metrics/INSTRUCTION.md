# xal-metrics Plugin 구현 작업 지시서

## 목표

XAL의 LLM 응답 및 Agent 실행 성능을 표시하는 독립 metrics plugin을 구현한다.

핵심 요구사항:

1. 현재 XAL에서 즉시 동작해야 한다.
2. stream hook이 없는 XAL에서도 오류 없이 동작해야 한다.
3. 향후 XAL에 optional stream hook이 추가되면 자동으로 고급 metrics를 활성화한다.
4. 사용자가 별도로 compatibility mode를 선택할 필요가 없어야 한다.
5. Provider별 구현을 만들지 않는다.
6. XAL이 제공하는 normalized Usage를 사용한다.

# 1. Compatibility 전략

두 가지 runtime capability를 지원한다.

## Legacy XAL

사용 가능:

prompt
before_tool
after_tool
turn_end

이 환경에서는:

- input tokens
- output tokens
- cache read
- cache write
- cache hit rate
- tool count
- tool duration
- provider
- model
- turn duration

등 가능한 데이터만 표시한다.

## Stream-enabled XAL

향후 XAL에 optional stream hook이 존재하는 경우 추가로:

- TTFT
- TPS
- generation duration
- stall
- first reasoning latency
- first text latency

를 자동 활성화한다.

# 2. 절대 요구사항

stream hook이 존재하지 않는다는 이유로:

- plugin load 실패
- runtime exception
- warning spam
- unsupported XAL version 메시지
- metrics 전체 비활성화

가 발생하면 안 된다.

Progressive enhancement 방식으로 구현한다.

기본 metrics는 항상 작동한다.

Streaming metrics는 capability가 있을 때만 추가된다.

# 3. Provider 독립성

Provider별 metrics adapter를 만들지 않는다.

금지:

providers/
anthropic.ts
openai.ts
google.ts
deepseek.ts

XAL Usage는 이미 normalized 되어 있다.

interface Usage {
totalInputTokens?: number
cacheReadInputTokens?: number
cacheWriteInputTokens?: number
outputTokens?: number
}

이를 그대로 사용한다.

# 4. Metrics 모델

내부 모델 예시:

interface TurnMetrics {
sessionId: string
provider: string
model: string

startedAt?: number
firstEventAt?: number
firstReasoningAt?: number
firstTextAt?: number
lastStreamAt?: number
completedAt?: number

totalInputTokens?: number
outputTokens?: number

cacheReadTokens?: number
cacheWriteTokens?: number

toolCount: number
toolDurationMs: number

stalls: number[]
}

실제 구조는 repository style에 맞게 조정한다.

# 5. Timing Clock

duration 계측에는 wall clock Date.now()보다 monotonic clock을 우선한다.

Node/Bun 환경에서 사용 가능한:

performance.now()

또는 기존 XAL/plugin 환경에서 사용하는 monotonic clock을 사용한다.

표시용 timestamp가 필요한 경우만 wall clock을 별도로 사용한다.

# 6. Turn 시작

가능한 가장 안정적인 lifecycle을 이용한다.

현재 XAL에서는 prompt hook을 이용하여 turn 시작 시간을 기록할 수 있다.

예:

prompt(input, ctx) {
metrics.start(ctx.session.id)
}

주의:

동일 session에서 여러 turn이 있으므로 session ID만으로 영구 단일 metric을 만들지 않는다.

Turn 단위 상태를 명확히 관리한다.

동시성 가능성도 고려한다.

# 7. Tool Metrics

beforeTool:

callId -> start time 저장

afterTool:

duration 계산

TurnMetrics에:

toolCount += 1
toolDurationMs += duration

추가.

필요하면 내부적으로 tool별 집계도 유지한다.

예:

bash 1.2s
read 0.6s
edit 0.3s

하지만 기본 compact UI에는 표시하지 않는다.

# 8. Usage Metrics

turnEnd에서:

usage.totalInputTokens
usage.outputTokens
usage.cacheReadInputTokens
usage.cacheWriteInputTokens

를 저장한다.

undefined와 0을 구분한다.

매우 중요하다.

undefined:

provider/XAL이 해당 정보를 제공하지 않음

0:

정보를 제공했으며 실제 값이 0

이 둘을 동일 취급하지 않는다.

# 9. Cache Hit Rate

cache 관련 정보가 실제 제공된 경우에만 계산한다.

예시 계산은 XAL Usage semantics를 코드에서 재검증한 뒤 결정한다.

목표는 "전체 prompt footprint 중 cache read가 차지한 비율"이다.

예:

cacheHitRate =
cacheRead /
relevantInputFootprint

XAL의 totalInputTokens가 cache read를 이미 포함하는지,
별도 uncached input만 의미하는지 반드시 실제 provider normalization 코드를 확인한다.

추측해서 denominator를 결정하지 않는다.

이 부분에 단위 테스트를 작성한다.

# 10. Cache 표시 정책

cache 데이터가 전혀 제공되지 않으면:

표시하지 않는다.

cacheRead가 실제 발생한 경우:

cache 92%

형태로 표시한다.

cacheWrite만 존재하는 경우에는 내부 데이터에는 기록하되
compact UI 정책은 별도 formatter에서 결정한다.

기본적으로 의미 없는:

cache 0%

를 항상 표시하지 않는다.

# 11. Stream Capability

향후 XAL stream hook API가 추가될 것을 고려한다.

중요:

현재 존재하지 않는 API를 정적으로 강제 참조해서
구버전 XAL에서 plugin 자체가 로드 실패하도록 만들지 않는다.

XAL plugin loading/type/runtime 구조를 분석하여
가장 안전한 feature detection 방식을 사용한다.

목표:

if stream capability available:
register stream observer
else:
continue legacy metrics

개념적으로:

const supportsStream = detectStreamCapability(ctx)

if (supportsStream) {
registerStreamingMetrics(...)
}

실제 API 형태는 Core PR의 최종 API와 맞춘다.

# 12. Core PR과의 느슨한 결합

xal-metrics 개발 시 Core PR이 아직 merge되지 않았다는 것을 전제로 한다.

따라서 두 작업이 병렬 진행 가능해야 한다.

stream integration 코드는 별도 module로 격리한다.

예:

metrics/
collector.ts
usage.ts
tools.ts
stream.ts
formatter.ts

stream.ts만 새로운 XAL API와 관계되도록 만든다.

나머지 plugin은 현재 XAL에서도 완성 가능해야 한다.

# 13. Streaming Metrics

stream hook이 존재할 경우 다음을 계측한다.

## First Event

첫:

reasoning_delta
reasoning_summary_delta
text_delta
item_done

등 실제 provider activity가 발생한 시간.

firstEventAt

## First Reasoning

첫:

reasoning_delta
reasoning_summary_delta

시간.

firstReasoningAt

## First Text

첫:

text_delta

시간.

firstTextAt

# 14. TTFT

내부적으로 두 지표를 구분한다.

firstEventLatency:
firstEventAt - startedAt

firstTextLatency:
firstTextAt - startedAt

UI의 TTFT 정의는 프로젝트에서 하나로 고정한다.

권장:

TTFT = firstTextLatency

단 reasoning-only 기간이 긴 모델 분석을 위해
firstEventLatency와 firstReasoningLatency는 내부 데이터에 유지한다.

필요하면 detail/debug UI에서 사용한다.

# 15. TPS

TPS는 반드시 provider usage의 outputTokens를 기준으로 계산한다.

텍스트 길이/문자 수를 token으로 추정하지 않는다.

권장:

generationDuration =
completedAt - firstTextAt

TPS =
outputTokens / generationDurationSeconds

단 reasoning token이 outputTokens에 포함되는 provider semantics가 있을 수 있으므로
XAL normalized Usage semantics를 확인한다.

정확한 계산이 불가능한 경우 잘못된 TPS를 표시하는 것보다
해당 metric을 숨기는 것을 우선한다.

# 16. Stall

stream event 사이의 gap을 측정한다.

기본 threshold:

1000ms

예:

if (currentAt - previousAt >= STALL_THRESHOLD) {
stalls.push(currentAt - previousAt)
}

단 다음 이벤트는 stall 계산에서 제외할 필요가 있는지 검토한다.

- done
- item_done
- tool boundary

LLM generation stream 내부의 실제 pause를 표현하도록 한다.

권장:

text/reasoning delta 간 gap 위주로 측정.

Tool 실행 시간을 stall로 잘못 집계하지 않는다.

# 17. Stall 표시

stall이 없으면:

아무것도 표시하지 않는다.

발생하면:

stall 2.1s×1

여러 번이면:

stall 4.8s×3

여기서 첫 숫자는 정책을 명확히 정한다.

권장:

총 stall duration × count

또는:

max stall × count

둘 중 하나를 선택하고 테스트/문서에 정의한다.

compact UI에는 max stall × count가 직관적일 수 있다.

# 18. Total

LLM request duration과 Agent Turn duration을 혼
