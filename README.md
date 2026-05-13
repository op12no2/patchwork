# eval

Cumulative LLM eval using phased sandboxed areas of a chess engine, starting with the evaluation function.

LLMs are given the phase-dependent prompt in ```prompt.md``` and the current chess engine code ```engine.js```. If the new code passes a [0,5] SPRT it becomes ```engine.js```. 

LLMs are given multiple attempts in a round-robin loop.

Syntax errors and crashes are not corrected.

The idea is that the strength will asymptote, with new LLM versions then making more headway.

The prompt is given in a new chat window using web UIs. So really it's testing the model in a web UI context rather than just the model, as knowledge can presumably leak between chats. But as a bit of fun, that's OK.

Results are logged in the repo wiki:-

https://github.com/op12no2/eval/wiki

Results marked with (*) passed SPRT.
