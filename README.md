## Patchwork

An informal cumulative and comptitive frontier LLM eval using a Javascript chess engine.

| Engine          | Model                       | CLI         | SPRT | ~Elo | Notes                | 
|-----------------|-----------------------------|-------------|------|------|----------------------| 
| 0005_opus_4_7   | Anthropic Claude Opus 4.7   | Claude Code | Pass | +30  | Leader               | 
| 0004_gpt_5_5    | OpenAI GPT 5.5              | Codex       | Fail |      |                      |
| 0003_opus_4_7   | Anthropic Claude Opus 4.7   | Claude Code | Pass | +130 |                      | 
| 0002_sonnet_4_6 | Anthropic Claude Sonnet 4.6 | Claude Code | Pass | +135 |                      | 
| 0001_haiku_4_5  | Anthropic Claude Haiku 4.5  | Claude Code | Fail |      |                      | 
| 0000_original   |                             |             |      |      | Boot engine          | 
 
See the ```engines``` dir for each engine source.

Models are given the chance to improve the currently leading engine to become the new leader using ```prompt.md```. The resultant engine is then evaluated by a [0,5] SPRT against the leading engine. 

```mermaid
---
config:
  xyChart:
    width: 500
    height: 300
  themeVariables:
    xyChart:
      titleColor: "#888888"
      xAxisLabelColor: "#888888"
      xAxisTitleColor: "#888888"
      xAxisTickColor: "#888888"
      xAxisLineColor: "#888888"
      yAxisLabelColor: "#888888"
      yAxisTitleColor: "#888888"
      yAxisTickColor: "#888888"
      yAxisLineColor: "#888888"
---
xychart
  x-axis "Engine #" [0, 1, 2, 3, 4, 5]
  y-axis "Relative Elo" 0 --> 200
  bar [0, 0, 135, 130, 0, 30]
```

The boot engine was around 1800 Elo.
