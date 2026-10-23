---
name: ml-experiments
description: Run small, reproducible ML, DL, RL, NLP, and computer vision experiments with honest evaluation. Use for dataset preparation, training, evaluation, model optimization, or any model performance claim.
---

# Reproducible ML experiments

## Define success before running

- State the task, primary metric, meaningful simple baseline, and acceptance
  criteria before tuning the model.
- Confirm the permitted hardware, runtime, downloads, storage, and external
  services. Bound training by steps, epochs, episodes, or a time limit.
- If the budget is unknown, use only small CPU checks on bundled or synthetic
  data. Ask before large downloads, GPU work, or substantial training.
- Prefer an established implementation to reimplementing a standard method.
  Do not introduce an experiment-management platform for a small experiment.

## Treat data correctly

- Record data sources, versions, licenses, and relevant preprocessing.
  Check model-weight licenses too when using pretrained models.
- Keep secrets, private data, and personally identifying information out of
  repositories and experiment reports.
- Keep train, validation, and test data separate. Prevent duplicate, subject,
  group, or temporal leakage as appropriate for the dataset.
- Fit preprocessing on training data only. Tune on validation data; do not
  repeatedly optimize against the held-out test set.
- Test important assumptions such as input shapes, label ranges, empty inputs,
  and invalid values. Do not silently discard bad records.

## Start simple

- First run a tiny end-to-end smoke check through the real pipeline.
- Establish a relevant baseline: for example, a constant predictor, linear
  model, classical vision method, or simple planning policy.
- Keep training, evaluation, and inference separately callable without
  duplicating preprocessing. Do not start training on module import.
- Put reusable behavior in ordinary source files. Notebooks may explore or
  explain results but must not be the only runnable implementation.
- Save configuration and checkpoints only as needed; avoid generic registries
  and elaborate configuration hierarchies.

## Evaluate fairly

- Use comparable data, preprocessing, evaluation conditions, and documented
  resource budgets for comparisons.
- Record seeds and seed the relevant libraries. Do not claim this guarantees
  identical results on every device or library version.
- For stochastic performance claims, use multiple seeds when practical and
  report variation. Label single-run results as preliminary.
- For RL, separate training from evaluation, use independent evaluation seeds,
  report policy behavior and variability, and handle episode endings correctly.
- Choose metrics that reflect the task. Account for class imbalance, false
  alarms, detection delay, or calibration when relevant.
- For speed or memory claims, record hardware, input size, batch size, warmup,
  measurement method, and model-quality tradeoffs.
- Report negative results and baseline wins. Never substitute synthetic
  examples or a successful smoke test for evidence of generalization.

## Leave useful evidence

Record the exact command, code revision when available, dependency versions,
data version and split, seeds, configuration, metrics, runtime, hardware, and
limitations. A small machine-readable result file is usually enough.

Keep generated results, logs, datasets, and weights out of version control by
default. A requested curated report may be committed; large artifacts need an
explicit storage decision.

State precisely what was run and what was not. Do not claim research novelty,
production readiness, or improvement beyond the available evidence.
