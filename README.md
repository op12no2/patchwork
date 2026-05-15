## Patchwork

An informal cumulative and comptitive frontier model eval using a Javascript chess engine.

| Engine                                        | Diff                              | Model                       | CLI         | SPRT | Notes                | 
|-----------------------------------------------|-----------------------------------|-----------------------------|-------------|------|----------------------| 
| [0007_opus_4_7](engines/0007_opus_4_7.js)     | [Δ](engines/0007_opus_4_7.diff)   | Anthropic Claude Opus 4.7   | Claude Code | ✓    | Leader               | 
| [0006_gpt_5_5](engines/0006_gpt_5_5.js)       | [Δ](engines/0006_gpt_5_5.diff)    | OpenAI GPT 5.5              | Codex       | ✓    |                      | 
| [0005_opus_4_7](engines/0005_opus_4_7.js)     | [Δ](engines/0005_opus_4_7.diff)   | Anthropic Claude Opus 4.7   | Claude Code | ✓    |                      | 
| [0004_gpt_5_5](engines/0004_gpt_5_5.js)       | [Δ](engines/0004_gpt_5_5.diff)    | OpenAI GPT 5.5              | Codex       | ✗    |                      |
| [0003_opus_4_7](engines/0003_opus_4_7.js)     | [Δ](engines/0003_opus_4_7.diff)   | Anthropic Claude Opus 4.7   | Claude Code | ✓    |                      | 
| [0002_sonnet_4_6](engines/0002_sonnet_4_6.js) | [Δ](engines/0002_sonnet_4_6.diff) | Anthropic Claude Sonnet 4.6 | Claude Code | ✓    |                      | 
| [0001_haiku_4_5](engines/0001_haiku_4_5.js)   | [Δ](engines/0001_haiku_4_5.diff)  | Anthropic Claude Haiku 4.5  | Claude Code | ✗    |                      | 
| [0000_original](engines/0000_original.js)     |                                   |                             |             |      | Boot engine          | 
 
Models are given the chance to improve on the currently leading engine to become the new leader using ```prompt.md``` and evaluated using a 10s+0.1s [0,5] SPRT. 

### Tournament

| Rank | Engine | Elo | Games | Score | Draws |
|-----:|--------|----:|------:|------:|------:|
| 1 | 0007_opus_4_7 | 2167 ±27.74 | 700 | 74.4% | 20.9% |
| 2 | 0006_gpt_5_5 | 2077 ±23.16 | 700 | 63.4% | 27.4% |
| 3 | 0004_gpt_5_5 | 2034 ±23.52 | 700 | 57.4% | 29.7% |
| 4 | 0005_opus_4_7 | 2026 ±22.81 | 700 | 56.4% | 32.9% |
| 5 | 0003_opus_4_7 | 2011 ±23.76 | 700 | 54.1% | 30.0% |
| 6 | 0002_sonnet_4_6 | 1931 ±25.41 | 700 | 42.8% | 28.0% |
| 7 | 0000_original | 1800 ±26.54 | 700 | 25.9% | 25.7% |
| 8 | 0001_haiku_4_5 | 1796 ±26.46 | 700 | 25.6% | 24.3% |

See ```bin/tourny``` for the spec.

### Notes

- There are Windows executables in ```./engines``` for anybody that is interested.

### Acknowledgements

-https://github.com/Disservin/fastchess - game runner
