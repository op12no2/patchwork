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
 
### Procedure 

Assume ```A``` is the current best engine (initially ````0000_original````). A model/CLI is selected to improve it by creating a new engine ```B``` using ```prompt.md```. If  a ```B``` v ```A``` SPRT passes, ```B``` becomes the new best engine. So for example ```0002_sonnet_4_6``` was derived from ```0000_original```, not ```0001_haiku_4_5```.   

```
    /---> 0001          /---> 0004
0000 ---> 0002 ---> 0003 ---> 0005 ---> 0006 etc.
   
```

See ```bin/sprt```.

### Tournament

| Rank | Engine | Elo | Games | Score | Draws |
|-----|--------|----|------|------|------|
| 1 | 0007_opus_4_7 | 2169 ±19.50 | 1400 | 75.8% | 22.6% |
| 2 | 0006_gpt_5_5 | 2063 ±16.41 | 1400 | 62.9% | 29.7% |
| 3 | 0005_opus_4_7 | 2020 ±16.18 | 1400 | 57.0% | 33.0% |
| 4 | 0004_gpt_5_5 | 2014 ±16.12 | 1400 | 56.2% | 33.1% |
| 5 | 0003_opus_4_7 | 2007 ±16.50 | 1400 | 55.2% | 30.6% |
| 6 | 0002_sonnet_4_6 | 1912 ±17.79 | 1400 | 41.6% | 27.7% |
| 7 | 0000_original | 1800 ±18.23 | 1400 | 27.2% | 27.6% |
| 8 | 0001_haiku_4_5 | 1771 ±19.14 | 1400 | 24.1% | 23.4% |

See ```bin/tourny``` for the spec.

### Notes

- There are Windows executables in ```./engines``` for anybody that is interested.

### Acknowledgements

- https://github.com/Disservin/fastchess - SPRT and tournament manager
