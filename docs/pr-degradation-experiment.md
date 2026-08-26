# PR degradation review experiment

## Objective

Test which compact review prompt and presentation best helps a human distinguish
architecturally good pull requests from degrading ones, without asking the
reader to scale their attention with the size of a pull request. The eventual
winner should be suitable for both a local, unmerged-branch review and a CI
review of an active pull request.

## PR selection and historical boundary

- Select the ten highest-numbered pull requests, including open, merged, and
  closed pull requests.
- Assess every pull request against the repository state at its base revision
  and its proposed diff.
- Do not use later pull requests or outcomes to reach a verdict. This keeps the
  method valid before merge.

## Shared analysis standard

For every pull request, assess:

1. **Day-one coherence.** If the change's problem had been known before any
   code existed, would this still be the simple, obvious, growth-friendly
   solution?
2. **Architectural fit.** Does it extend the base revision's modules, data
   flow, and boundaries naturally, or does it work around them?
3. **New patterns.** Which genuinely new patterns does it introduce, and are
   they coherent enough to repeat?
4. **Agent-verifiable behaviour.** Can an agent objectively determine whether
   the changed behaviour works through a focused test, deterministic command,
   inspectable API output, or a startable, automatable interface? This applies
   beyond UI work.

The first pull request receives the same absolute coherence and verifiability
assessment; it is not judged only relative to predecessor code.

Use the same bounded evidence for every variant: pull-request metadata, base
revision, proposed diff, changed-file list, architecture and decision records
available at that base, and executable verification contracts. Report a
concrete concern or a meaningful uncertainty only when it has small observable
evidence. When there is no material concern, produce only a short verdict and
confidence rather than padded analysis.

## Experiment deliverable

Create one local HTML dossier with an index and a responsive page for each
pull request. Each page presents five prompt-and-presentation variants:

1. Graph-like presentation.
2. Sequence-diagram-like presentation.
3. Bullet-point presentation.
4. A prompt and presentation independently designed by one Sol sub-agent.
5. A deliberately contrasting prompt and presentation independently designed
   by another Sol sub-agent.

The reader will make a freeform judgement of which variant best reveals the
difference between good and bad pull requests. Do not impose a scoring rubric
or store the experiment outcome unless asked later.
