# Code and a table

```python
@dataclass
class Talk:
    title: str
    minutes: int = 20

    def pace(self, n: int) -> float:
        # minutes per slide
        return self.minutes / n
```

::right::

| Layout     | Zones | For          |
|------------|------:|--------------|
| `content`  |     2 | Most slides  |
| `two-cols` |     3 | Side by side |
| `fact`     |     2 | A big number |
| `quote`    |     2 | A quotation  |
