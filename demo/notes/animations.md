Every built-in animation is a Python dataclass that subclasses `Animation`. The CSS
class is derived from the type name automatically: `FadeIn → anim-fade-in`,
`SlideIn → anim-slide-in`.

Adding a custom animation only requires two things: a Python dataclass (like `Flicker`
at the top of `deck.py`) and a matching `@keyframes anim-flicker` rule in a CSS file.
No registration step — inkflow discovers the class name from the type.
