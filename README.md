## Patchwork

An informal cumulative and comptitive frontier model eval using a Javascript chess engine.

| Engine                                                                          | Model                       | CLI         | SPRT | ~Elo | Notes                | 
|---------------------------------------------------------------------------------|-----------------------------|-------------|------|------|----------------------| 
| [0007_opus_4_7](engines/0007_opus_4_7.js) [Δ](engines/0007_opus_4_7.diff)       | Anthropic Claude Opus 4.7   | Claude Code | Pass | +115 | Leader               | 
| [0006_gpt_5_5](engines/0006_gpt_5_5.js) [Δ](engines/0006_gpt_5_5.diff)          | OpenAI GPT 5.5              | Codex       | Pass | +25  |                      | 
| [0005_opus_4_7](engines/0005_opus_4_7.js) [Δ](engines/0005_opus_4_7.diff)       | Anthropic Claude Opus 4.7   | Claude Code | Pass | +30  |                      | 
| [0004_gpt_5_5](engines/0004_gpt_5_5.js) [Δ](engines/0004_gpt_5_5.diff)          | OpenAI GPT 5.5              | Codex       | Fail |      |                      |
| [0003_opus_4_7](engines/0003_opus_4_7.js) [Δ](engines/0003_opus_4_7.diff)       | Anthropic Claude Opus 4.7   | Claude Code | Pass | +130 |                      | 
| [0002_sonnet_4_6](engines/0002_sonnet_4_6.js) [Δ](engines/0002_sonnet_4_6.diff) | Anthropic Claude Sonnet 4.6 | Claude Code | Pass | +135 |                      | 
| [0001_haiku_4_5](engines/0001_haiku_4_5.js) [Δ](engines/0001_haiku_4_5.diff)    | Anthropic Claude Haiku 4.5  | Claude Code | Fail |      |                      | 
| [0000_original](engines/0000_original.js)                                       |                             |             |      |      | Boot engine          | 
 
Models are given the chance to improve on the currently leading engine to become the new leader using ```prompt.md``` and evaluated using a 10s+0.1s [0,5] SPRT. 

If anybody out there has the inclination to test the engines, there are Windows executables in ```./engines```.

The boot engine is around 1800 Elo. The Elo column is a very rough estimate; passing the SPRT is the important thing.
