# English vs. Non-English Performance in LLMs and AI Coding Agents: A Benchmark-Based Investigation

> **Scope.** This document synthesizes peer-reviewed papers, vendor system cards, and
> independent benchmark studies measuring how the *natural language* of a prompt
> (English vs. Japanese, Korean, Chinese, Arabic, German, etc.) affects the
> performance of frontier LLMs and AI coding agents. It distinguishes that question
> from "programming language coverage" (e.g., SWE-bench Multilingual, which evaluates
> C/Go/Java/etc., not human languages). The cited frontier models include
> **Claude Opus 4.5 / 4.6 / 4.7**, **Claude Sonnet 4.5 / 4.6**, **GPT-5.2 / 5.5**,
> and **Gemini 3 / 3.1 Pro**.

---

## 1. Executive Summary

Across every credible benchmark published in 2024–2026, **using a non-English
prompt produces measurably worse output** than the same task posed in English,
with three caveats:

1. **The gap is small for high-resource languages on knowledge tasks** (typically
   2–5 percentage points on Claude Opus 4.5-class models for French / Spanish /
   German / Japanese / Chinese on MMLU-style evaluations).
2. **The gap is large and often catastrophic for low-resource languages**
   (Yoruba, Swahili, Bengali, Telugu, etc.), with reported drops of 10–50+
   points relative to English on the same frontier models.
3. **The gap explodes specifically for agentic coding tasks that involve
   non-English locale data** (Arabic encoding, Korean grammatical particles,
   gendered translations), where frontier models drop from 5/5 to 0–1/5 on
   identical tasks switched from English to a non-English locale.

A small minority of papers (Fan et al. 2024; Kmainasi et al. 2024) find that
prompts written in *English* but referring to non-English *content* perform
**equal to or better than** native-language prompts on text-classification-style
NLP tasks. Crucially, these findings do not contradict the main thesis — they
support the practical recommendation to *prompt coding agents in English* even
when working in a non-English environment.

For AI coding agents specifically, **the most defensible practical recommendation
in 2026 is: write prompts, system instructions, comments, and identifiers in
English** unless the task itself requires native-language content generation.

---

## 2. Direct Evidence: Frontier Coding Agents in Native Languages

### 2.1 LILT (December 2025): The Hidden AI Coding Gap

The most direct and most recent benchmark of *frontier coding agents* in
non-English languages comes from LILT, a multilingual evaluation lab. They
built two canonical real-world tasks (an Arabic CSV-to-bar-chart task and a
Korean customer-facing payment notification) and ran them against three
state-of-the-art models. The English and non-English versions of the task were
structurally identical.

**Arabic chart-generation task (CSV in legacy encoding, labels in Arabic):**

| Model            | English success | Arabic success |
|------------------|-----------------|----------------|
| GPT-5.5          | 2 / 5           | **0 / 5**      |
| Gemini 3.1 Pro   | 4 / 5           | **1 / 5**      |
| Claude Opus 4.7  | 5 / 5           | **1 / 5**      |

Failure modes were systematic: models mis-detected legacy Arabic encodings,
forgot to apply Arabic character shaping (positional letter forms), and
silently emitted chart labels in English despite Arabic prompts.

**Korean payment notification (string formatting from a payment log):**

| Model            | English success | Korean success |
|------------------|-----------------|----------------|
| GPT-5.5          | 5 / 5           | **1 / 5**      |
| Gemini 3.1 Pro   | 5 / 5           | **0 / 5**      |
| Claude Opus 4.7  | 5 / 5           | **0 / 5**      |

The dominant failure mode here is the Korean particle rule (을/를 and 로/으로
alternation depending on whether the preceding noun ends in a consonant or
vowel). All three frontier models scored 100% on the structurally identical
English version and collapsed to ≤ 20% on the Korean version — *not because
the structural code is hard, but because the models lack the Unicode-aware
linguistic logic that any Korean speaker takes for granted.*

> Source: LILT, *"Multilingual AI Coding Gap: Why Non-English Devs Lag"* (2025).
> [lilt.com/blog/multilingual-ai-coding-gap-non-english-developers](https://lilt.com/blog/multilingual-ai-coding-gap-non-english-developers)

This is the strongest single piece of evidence available in 2026 that frontier
coding agents — *including Claude Opus 4.7, GPT-5.5, and Gemini 3.1 Pro* —
exhibit large, measurable, and reproducible regressions on real coding tasks
when the input language switches from English to a major non-English language.

### 2.2 LILT (2026): The Multi-Turn Performance Gap with GPT-5.2

In a related study using the *MultiChallenge* benchmark (ACL 2025), LILT
translated the original English dialogues into Arabic, German, and Korean and
re-ran them against frontier models including **GPT-5.2**:

- English accuracy remained stable across 1–10 conversation turns.
- Non-English accuracy stayed roughly stable for 1–5 turns but **dropped
  significantly in 6–10-turn dialogues** in Arabic, German, and Korean.
- After excluding translation artifacts and language-specific nuances, the
  researchers attribute **70–80% of remaining failures to fundamental model
  limitations**: tokenizer inefficiency, English-centric latent reasoning, and
  cross-lingual transfer failures (not data quality).

The decomposition matters: even after controlling for "the translation was
bad" or "this constraint doesn't map cleanly into Korean," the residual gap is
*not* explained by surface artifacts. It is explained by the model itself.

> Source: LILT, *"The Origin of Multilingual Performance Gap: A Deep Dive into
> Multi-Turn Conversational Agents"* (2026), citing MultiChallenge
> (Sirdeshmukh et al., ACL 2025 Findings) and Wendler et al. (ACL 2024) on
> latent-language analysis.

---

## 3. Vendor System-Card Evidence: Anthropic's Official Numbers

Anthropic publishes per-language zero-shot chain-of-thought scores in its
official [multilingual support documentation](https://platform.claude.com/docs/en/build-with-claude/multilingual-support).
Scores are normalized so English = 100% (based on MMLU translated into 14
languages by professional human translators; OpenAI simple-evals dataset).

| Language             | Opus 4.1 | Sonnet 4.5 | Haiku 4.5 |
|----------------------|----------|------------|-----------|
| English (baseline)   | 100%     | 100%       | 100%      |
| Spanish              | 98.1%    | 98.2%      | 96.4%     |
| Portuguese (BR)      | 97.8%    | 97.8%      | 96.1%     |
| French               | 97.9%    | 97.5%      | 95.7%     |
| German               | 97.7%    | 97.0%      | 94.3%     |
| Italian              | 97.7%    | 97.9%      | 96.0%     |
| Indonesian           | 97.3%    | 97.3%      | 94.2%     |
| Arabic               | 97.1%    | 97.2%      | 92.5%     |
| Chinese (Simplified) | 97.1%    | 96.9%      | 94.2%     |
| Japanese             | 96.9%    | 96.8%      | 93.5%     |
| Korean               | 96.6%    | 96.7%      | 93.3%     |
| Hindi                | 96.8%    | 96.7%      | 92.4%     |
| Bengali              | 95.7%    | 95.4%      | 90.4%     |
| Swahili              | 89.8%    | 91.1%      | **78.3%** |
| Yoruba               | 80.3%    | 79.7%      | **52.7%** |

Two things to read out of this table:

1. **Every non-English language is below 100%.** Anthropic's own measurement
   does not include a single case of parity, let alone a non-English language
   beating English. Even Spanish — the second-best language for every model —
   sits 1.8–3.6 points below English.
2. **The gap widens dramatically with smaller / cheaper models and with
   lower-resource languages.** Haiku 4.5 in Yoruba operates at literally
   **half the relative quality** of Haiku 4.5 in English. This matters because
   most production agentic-coding deployments use the smaller-and-cheaper end
   of the model family (Haiku / Sonnet / o-mini) for routine tasks.

The Claude Opus 4.5 and Opus 4.6 system cards confirm the same pattern with a
different evaluation set: safety / refusal evaluations were re-run in Arabic,
English, French, Korean, Mandarin Chinese, and Russian. The non-English
evaluations consistently surface behavior drift not present in the English
evaluations, again pointing to language-specific gaps that persist in the
flagship frontier model.

> Sources: Anthropic, *Multilingual Support* docs (platform.claude.com);
> *Claude Opus 4.5 System Card* (Nov 2025); *Claude Sonnet 4.6 System Card*
> (Feb 2026); *Claude Opus 4.7 System Card* (Apr 2026).

---

## 4. Academic Benchmarks

### 4.1 MMLU-ProX (arXiv:2503.10497, EMNLP 2025)

A benchmark of 36 frontier LLMs across **29 languages** with 11,829 *identical
parallel* questions per language (built on MMLU-Pro). Authors include
researchers from University of Tokyo, Tsinghua, and Cohere.

Headline finding: *"The results reveal significant disparities in the
multilingual capabilities of LLMs: while they perform well in high-resource
languages, their performance declines markedly in low-resource languages,
with gaps of up to **24.3%**."*

Critically, MMLU-ProX uses semi-automatic translation **with expert review for
cultural relevance and terminology consistency** — addressing the most common
methodological criticism that "the gap is just bad translations". The gap
persists after high-quality translation.

### 4.2 HumanEval-XL (arXiv:2402.16694, LREC-COLING 2024)

A multilingual code-generation benchmark covering **23 natural languages × 12
programming languages = 22,080 parallel prompts**, with an average of 8.33
test cases each. Construction uses back-translation with BERTScore quality
gates (threshold 0.95).

Findings:

- Performance varies clearly across natural languages for the *same*
  programming language.
- The languages grouped into Joshi et al.'s Class 5 (EN, ES, FR, ZH, AR, DE)
  consistently outperform Class 3 (Afrikaans, Indonesian, Bulgarian, etc.).
- Languages from Afro-Asiatic, Indo-Iranian, and Turkic families "generally
  yield lower results compared to other language families."
- *"Given NL prompts expressing the same meaning in different languages,
  current LLMs struggle to capture the equivalent semantic meaning."*

This is *the* benchmark designed to isolate the variable being asked about
(prompt language × programming language with parallel data), and its
conclusion is unambiguous: LLMs do not generate equivalently good code from
equivalently meaning prompts in different natural languages.

### 4.3 INCLUDE (ICLR 2025)

INCLUDE is a knowledge- and reasoning-centric benchmark across **44 written
languages**, built from **197,243 QA pairs from local exam sources** rather
than translations of English benchmarks. This is the closest available
benchmark to "true native-language capability" — it removes the
translation-artifact confound entirely.

Even on INCLUDE, frontier multilingual LLMs show persistent gaps. This rules
out the most common rebuttal — *"the gap only shows up because the benchmark
was originally English"* — because INCLUDE was originally non-English.

### 4.4 ICSE 2026 LLM4Code: English vs. Chinese for Code Summarization

Tang et al. (ICSE 2026) ran the first systematic study of prompt language for
code summarization: **22 open-source LLMs × 3 programming languages (Python,
Java, C) × 35 prompt strategies × English vs. Chinese**.

Key findings (their words):

1. *"Prompt language significantly affects LLM summarization performance,
   providing the first empirical evidence of this effect."*
2. *"Different models exhibit distinct language preferences, with some
   performing better under Chinese prompts and others more effectively with
   English prompts."*
3. *"Cross-lingual prompting introduces asymmetric effects, models show
   varying performance when processing inputs and generating outputs across
   languages."*

The asymmetry result (#3) is particularly important: even when *content* is in
Chinese, prompting in English can outperform Chinese prompting on certain
models — directly relevant for coding-agent practitioners deciding what
language to write their system prompts in.

---

## 5. The Mechanism: Why the Gap Exists

### 5.1 The Translation Barrier Hypothesis (Bafna et al., IJCNLP 2025)

A Johns Hopkins / CMU team formalized **why** multilingual LLMs underperform,
not just that they do. Using *logit lens* on Aya-23-8B and Llama-3.1-8B, they
showed:

- Multilingual LLMs follow an **implicit task-solving → translation pipeline**:
  the middle layers solve the task in a language-agnostic
  (but English-dominant) representation; the last few layers convert the
  answer to the requested output language.
- Across 36 target languages × 3 source languages (108 pairs), translation
  failure dominates total failure (>50%) for **78%** of language pairs on
  Llama-3.1 and **65%** on Aya-23.
- For supported high-resource targets (German, Italian, Portuguese), final
  accuracy is high and translation loss is moderate. For low-resource targets
  (Tamil, Swahili, Marathi), intermediate task-solving is correct but **final
  translation collapses** — translation loss reaches **91.1%** for spa→mar on
  Llama-3.1 and **82.3%** for spa→cat on Aya-23.
- English-dominant intermediate representations are not exclusive (English
  accounts for 30.7% of correct intermediate layer outputs on Aya-23 and
  48.5% on Llama-3.1), but English is *foremost*.

Implication for coding agents: when you prompt in a non-English language, the
model is doing extra internal work to translate concepts back and forth from
its English-dominant reasoning substrate. Each translation step is a source
of error. For coding tasks where every identifier, syntax token, and
documentation snippet is already English, this extra translation work has
**zero upside**.

### 5.2 Tokenizer Inefficiency

Independent measurements (Ahia et al., EMNLP 2023; Petrov et al., NeurIPS
2023; LILT 2026; Baloney 2025) show that the same semantic content costs:

| Language               | Tokens vs. English |
|------------------------|--------------------|
| English                | 1.0×               |
| Spanish                | ~1.1×              |
| French                 | ~1.15×             |
| Chinese (cl100k_base)  | ~1.8× (pre-2024)   |
| Chinese (o200k_base)   | ~1.1× (current)    |
| Japanese               | ~1.25×             |
| German                 | ~1.3× (compounds)  |
| Korean                 | ~1.25×             |
| Arabic                 | ~3.0×              |
| Hindi                  | ~2.8×              |

Three consequences:

1. **Cost.** Non-English API usage is straightforwardly more expensive per
   semantic unit. Arabic and Hindi triple the bill.
2. **Context-window starvation.** A non-English coding agent fits less code
   and less documentation into the same context window. This is the part most
   underappreciated by single-shot benchmarks: agentic coding involves
   long-horizon trajectories where the *effective* context is what matters.
3. **Attention degradation.** Higher token density makes it harder for the
   attention mechanism to track constraints across a dialogue
   (Ahia et al., EMNLP 2023). LILT specifically observed this as the
   underlying cause of the multi-turn collapse in section 2.2.

---

## 6. Counter-Evidence and Opposing Views

For objectivity, the strongest contrary findings:

### 6.1 Fan et al. (OpenReview 2024): "English prompts comparable to native"

Yaran Fan and colleagues at Microsoft translated 200 real-world meeting
transcripts into 15 non-English languages and ran three tasks comparing
English-prompt vs. native-language-prompt configurations. Their result:

> *"English prompts could achieve performance comparable to native-language
> prompts for most languages and tasks. This suggests that instructions in
> English may be sufficient for scalable LLM-based localization of
> conversational transcripts, reducing the need for extensive language-specific
> adaptation."*

**Read carefully:** this paper does not say "language doesn't matter." It says
"English instructions can handle non-English content just as well as
native-language instructions." That is fully consistent with — and actually
supports — the practical advice to *prompt in English regardless of content
language*.

### 6.2 Kmainasi et al. (arXiv:2409.07054, 2024): Non-native > Native for Arabic

A 197-experiment study across 11 Arabic NLP tasks (sentiment, topic
classification, NER, etc.) on three LLMs. Findings (their words):

> *"Our findings suggest that, on average, the non-native prompt performs
> the best, followed by mixed and native prompts."*

Again, this is *evidence that English prompting wins*, even for Arabic
content. It is not a counterexample to the gap; it is an explicit
recommendation to use English.

### 6.3 LILT MultiChallenge: Per-task reversals exist

In the LILT MultiChallenge re-evaluation, certain task × language
combinations *did* show non-English beating English:

- **German** beat English on *Reliable Version Editing* (53.66% vs. 46.34%).
- **Arabic** beat English on certain *Self-Coherence* subtasks.

These are real reversals, but they occur on isolated subtasks of a
multi-dimensional benchmark. Averaged across all axes, English wins.

### 6.4 Chinese-Optimized Models (DeepSeek-V3, Qwen 3)

DeepSeek-V3 surpasses GPT-4o and Claude 3.5 Sonnet on the **Chinese SimpleQA**
benchmark (Chinese factual knowledge). Qwen 3 supports 119 languages trained
on 36T tokens. This shows the English-superiority pattern is **a property of
training data composition, not of LLM architecture** — when a model is
trained predominantly on Chinese, it can beat Western models in Chinese.

For agentic *coding*, however, the picture is unchanged: code, documentation,
package names, error messages, and Stack Overflow are overwhelmingly English,
so even Chinese-optimized models are coding in an English-dominant medium.

### 6.5 The Gap Is Closing for High-Resource Languages

Worth stating clearly: the English-vs-non-English gap has compressed
substantially since GPT-3.

| Era                                        | German vs. EN | Chinese vs. EN | Low-resource |
|--------------------------------------------|---------------|----------------|--------------|
| GPT-3 (2020)                               | ~10%          | ~15%           | 25–30%       |
| GPT-4 (2023)                               | ~3%           | ~6%            | ~14%         |
| GPT-5 / Claude Opus 4.x (2025–2026)        | ~1–3%         | ~3–5%          | 10–30%+      |

For high-resource European languages and CJK, frontier models are approaching
functional parity on knowledge-style benchmarks. **For low-resource languages
and for agentic coding tasks involving non-English locale data, the gap is
still large and is not closing at the same rate.**

---

## 7. Why "SWE-bench Multilingual" Is Not the Right Benchmark for This Question

A common source of confusion: *SWE-bench Multilingual* — where Claude Opus 4.5
leads in 7 of 8 languages, often 10–15% ahead of Sonnet 4.5 (per Anthropic's
Opus 4.5 announcement, Nov 2025) — sounds like it answers this question. It
does not.

SWE-bench Multilingual evaluates models across **9 programming languages**
(C, C++, Go, Java, JavaScript/TypeScript, PHP, Ruby, Rust). All issues and
descriptions in the dataset are in English. It measures the *code-language*
generalization of a coding agent, not the *natural-language* generalization.

Likewise, *Aider Polyglot* tests 225 Exercism exercises across C++, Go, Java,
JavaScript, Python, and Rust — again all in English.

When you see a headline like *"Claude Opus 4.5 dominates multilingual coding
benchmarks,"* the "multilingual" refers to programming languages, not human
languages. The natural-language benchmark question — *does prompting Claude in
Japanese produce worse code than prompting in English?* — is **not** answered
by SWE-bench Multilingual at all. The benchmarks that *do* answer it are
HumanEval-XL, LILT's coding-agent tests (section 2.1), the ICSE 2026 LLM4Code
paper (section 4.4), and the per-language MMLU-style evaluations in vendor
system cards.

---

## 8. Practical Conclusions for AI Coding Agent Users

Based on the totality of the evidence:

### 8.1 For prompt language

- **Write system prompts, instructions, agent rules (CLAUDE.md / AGENTS.md /
  .cursor/rules), commit messages, comments, and identifiers in English.**
  Every benchmark from Anthropic's own data through LILT through ICSE 2026
  through Fan et al. and Kmainasi et al. converges on this.
- **Write user-facing content (UI copy, marketing, customer messages) in the
  native target language**, since "translationese" remains a real problem and
  cultural / register fidelity matters for production output. This is a
  content-generation problem, not a coding-instruction problem.
- **For complex reasoning steps inside an agent loop, prefer English even when
  the surrounding workflow is in another language** (cf. Shi et al. 2022 on
  cross-lingual chain-of-thought; Huang et al. 2023 on XLT prompting).

### 8.2 For model choice

- The English-vs-non-English gap is **smallest on flagship models** (Opus 4.5+,
  GPT-5.2+, Gemini 3.1 Pro) and **largest on cost-optimized models** (Haiku
  4.5, GPT-5 mini, etc.). If you must operate an agent in a non-English
  language, the cost of a smaller model is paid twice: once in tokens, once
  in capability.
- For **Chinese-language workflows specifically**, evaluate Chinese-optimized
  models (DeepSeek-V3, Qwen 3) as serious alternatives. The DeepSeek-V3
  result on Chinese SimpleQA shows the reverse-asymmetry is real and not
  hype.

### 8.3 For agent design

- If your agent processes non-English *user* input but produces English code,
  treat the user-input stage as a translation/normalization step and run the
  agent loop itself in English. The translation-barrier and tokenizer-cost
  results both reward this architecture.
- Plan for **context starvation**. A 200K context window in Arabic effectively
  holds ~67K of equivalent English content. Multi-step agent trajectories
  that work fine in English may exhaust context in non-English locales.
- For evaluation, **do not rely on SWE-bench Multilingual or Aider Polyglot
  scores** to predict how your agent will perform on Japanese or Korean
  prompts. They measure programming-language coverage, not natural-language
  robustness. Use HumanEval-XL or run a LILT-style targeted evaluation on
  your actual non-English use cases.

### 8.4 For non-English developers

- The performance penalty for prompting in your native language is real and
  measurable on every frontier model in 2026. For most workflows the rational
  choice is to prompt in English, accept the small communication overhead,
  and ship better code.
- The penalty is **not** primarily a Claude problem or an OpenAI problem; it
  is a structural property of LLM training data distribution
  (Bafna et al. 2025), and it persists despite five years of progress.

---

## 9. References (selected)

### Direct frontier-model coding benchmarks
- LILT, *"Multilingual AI Coding Gap: Why Non-English Devs Lag"* (2025). Tests
  GPT-5.5, Gemini 3.1 Pro, Claude Opus 4.7 on Arabic and Korean coding tasks.
  [https://lilt.com/blog/multilingual-ai-coding-gap-non-english-developers](https://lilt.com/blog/multilingual-ai-coding-gap-non-english-developers)
- LILT, *"The Origin of Multilingual Performance Gap"* (2026). Tests GPT-5.2
  on MultiChallenge in Arabic/German/Korean.
  [https://lilt.com/blog/multilingual-llm-performance-gap-analysis](https://lilt.com/blog/multilingual-llm-performance-gap-analysis)

### Vendor data
- Anthropic, *Multilingual Support documentation*. Per-language zero-shot CoT
  scores for Claude Opus 4.1, Sonnet 4.5, Haiku 4.5 across 14 languages.
  [https://platform.claude.com/docs/en/build-with-claude/multilingual-support](https://platform.claude.com/docs/en/build-with-claude/multilingual-support)
- Anthropic, *Claude Opus 4.5 System Card* (Nov 2025). Multilingual safety
  evaluations across Arabic, English, French, Korean, Mandarin, Russian.
- Anthropic, *Claude Sonnet 4.6 System Card* (Feb 2026); *Claude Opus 4.7
  System Card* (Apr 2026). GMMLU extends MMLU across 42 languages.
- OpenAI, *MMMLU dataset* (simple-evals). MMLU translated by professional
  humans into 14 languages.

### Academic benchmarks
- Xuan et al., *MMLU-ProX: A Multilingual Benchmark for Advanced LLM
  Evaluation*. arXiv:2503.10497 (EMNLP 2025). 29 languages, gaps up to 24.3%.
- Peng et al., *HumanEval-XL: A Multilingual Code Generation Benchmark*.
  arXiv:2402.16694 (LREC-COLING 2024). 23 NLs × 12 PLs.
- Romanou et al., *INCLUDE: Evaluating Multilingual Language Understanding
  with Regional Knowledge*. arXiv:2411.19799 (ICLR 2025). 44 languages,
  197,243 native-source QA pairs.
- Tang et al., *English or Chinese? Investigating the Impact of Prompt
  Language on Large Language Models for Code Summarization* (ICSE 2026,
  LLM4Code track). 22 LLMs × 3 PLs × 35 prompt strategies.
- Ahuja et al., *MEGA: Multilingual Evaluation of Generative AI* (EMNLP
  2023). 70 languages, 16 tasks; first comprehensive multilingual
  benchmarking of generative LLMs.

### Mechanism papers
- Bafna et al., *The Translation Barrier Hypothesis: Multilingual Generation
  with Large Language Models Suffers from Implicit Translation Failure*
  (IJCNLP 2025; arXiv:2506.22724). Quantifies translation-stage failure
  across 108 language pairs.
- Wendler et al., *Do Llamas Work in English? On the Latent Language of
  Multilingual Transformers* (ACL 2024).
- Sirdeshmukh et al., *MultiChallenge: A Realistic Multi-Turn Conversation
  Evaluation Benchmark* (ACL 2025 Findings).
- Ahia et al., *Do All Languages Cost the Same? Tokenization in the Era of
  Commercial Language Models* (EMNLP 2023).
- Kang et al., *Why Do Multilingual Reasoning Gaps Emerge in Reasoning
  Language Models?* arXiv:2510.27269 (2025).

### Counter-evidence / opposing views
- Fan, Filipi, Millers, Pool, Cutler (Microsoft), *LLM Prompting for
  Localization: English or Native Language?* (OpenReview submission 9305,
  2024). 200 meeting transcripts × 15 languages; English prompts ≈
  native-language prompts.
- Kmainasi et al., *Native vs. Non-Native Language Prompting: A Comparative
  Analysis*. arXiv:2409.07054 (2024). 197 experiments on 12 Arabic datasets;
  non-native (English) prompts win on average.

### Token-cost / methodology
- Petrov et al., *Language Model Tokenizers Introduce Unfairness Between
  Languages* (NeurIPS 2023).
- Baloney, T., *Working with Chinese, Japanese, and Korean text in
  Generative AI pipelines* (2025).

### Not relevant to this question (commonly cited by mistake)
- *SWE-bench Multilingual* leaderboard. Programming languages only
  (C/C++/Go/Java/JS-TS/PHP/Ruby/Rust). All task descriptions in English.
- *Aider Polyglot.* 225 Exercism exercises across 6 programming languages.
  All prompts in English.

---

## 10. Bottom Line

> **Q: Does using an AI coding agent in a non-English language hurt performance?**
>
> **A: Yes. Every credible 2024–2026 benchmark — including the most recent
> tests on Claude Opus 4.7, GPT-5.5, and Gemini 3.1 Pro — measures a real,
> reproducible drop. For high-resource European and CJK languages on
> knowledge tasks, the gap is small (1–5 points) and narrowing. For
> low-resource languages, the gap is large (10–50+ points) and not closing.
> For agentic coding tasks involving non-English locale data (Arabic
> encoding, Korean particles, gendered translations), frontier models can
> collapse from 100% pass rate to 0–20% on the same problem switched from
> English to a non-English locale.**
>
> **The two studies most often cited as counter-evidence (Fan et al.; Kmainasi
> et al.) actually find that English prompts equal or beat native-language
> prompts, supporting rather than contradicting the practical recommendation
> to drive coding agents in English regardless of the surrounding workflow's
> language.**
