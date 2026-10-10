# A Short Title That States the Finding

::authors::
**Ada Lovelace**¹, Charles Babbage², Grace Hopper¹

::affiliations::
¹ University of Somewhere · ² Institute of Elsewhere

::col-1::
## Background

Say in two or three sentences what problem this work addresses and why it
matters. A poster is read from a step away, in a minute or two: keep every
section short.

- One point per bullet
- Large enough to read from two metres
- Figures carry the story, text supports them

## Question

Can a larger model reach a higher accuracy on the held-out set than the
baseline, and by how much?

::col-2::
## Method

![The method in three steps](../figures/method.svg)

We collected 1,200 samples, trained three model variants and evaluated each
on a held-out set against the same baseline.

## Results

```chart
data: ../data/results.csv
kind: bar
title: Accuracy (%)
y-min: 0
y-max: 100
labels: true
aspect: 4:3
```

Every variant beats the baseline; the large one by 22 points.

::col-3::
## Conclusions

1. Accuracy grows with model size.
2. The baseline stays flat.
3. The gain is largest between small and medium.

## Next steps

Test on a second data set, and measure the cost of the larger model.

## Acknowledgements

We thank the people and funders who made this work possible.

::references::
1. Lovelace, A. (1843). Notes on the Analytical Engine. *Scientific Memoirs* 3, 666–731.
2. Hopper, G. (1952). The education of a computer. *Proc. ACM*, 243–249.

::contact::
**Ada Lovelace**  
ada@example.org
