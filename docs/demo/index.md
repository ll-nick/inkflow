# Demo

An interactive demo of the built-in theme is embedded below.

!!! note "Building the demo"
    The demo is generated from the showcase deck and is not committed to the repository.
    To build it locally:

    ```bash
    inkflow build src/inkflow/theme/showcase/deck.py --output docs/demo
    mkdocs serve
    ```

    Or add it as a poe task:

    ```bash
    poe docs-build-demo   # see pyproject.toml
    ```

<!-- Once the demo HTML is generated, embed it here:

<iframe
  src="./presentation/index.html"
  width="100%"
  style="aspect-ratio: 16/9; border: none; border-radius: 8px;"
  allowfullscreen>
</iframe>

-->
