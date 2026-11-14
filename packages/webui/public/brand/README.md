# 品牌资源

`logo-2x.png` / `logo-3x.png` / `favicon-64.png` 都从 WeQ 的
`docs/images/logo.png`（590 × 600，透明底）等比缩放而来，没有改色、没有重绘：

| 文件                        | 用途                       |
| --------------------------- | -------------------------- |
| `logo-2x.png`（283 × 288）  | 1× / 普通 DPI 屏幕         |
| `logo-3x.png`（425 × 432）  | 高分屏（`srcset` 的 3x）   |
| `favicon-64.png`（63 × 64） | 站点图标（`/favicon.png`） |

WeQ 的 `docs/images/logo.png` 与 `resources/brand/logo.png` 像素相同、仅压缩参数不同，
这里取前者。

要重新生成（比如换了新 logo）：

```bash
python3 - <<'PY'
from PIL import Image
src = Image.open('../WeQ/docs/images/logo.png').convert('RGBA')
for name, h in (('logo-2x', 288), ('logo-3x', 432), ('favicon-64', 64)):
    w = round(src.width * h / src.height)
    src.resize((w, h), Image.LANCZOS).save(f'public/brand/{name}.png', optimize=True)
PY
```

> 用 `<img>` 而不是内联 SVG：品牌图是位图，内联也没法做主题换色，没必要把 100 KB
> 的 base64 塞进 JS 包。
