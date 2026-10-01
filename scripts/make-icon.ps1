# Builds renderer/img/icon.png (app/window/exe icon, transparent outside a round badge) from the
# source artwork renderer/img/logo.png.   Run after replacing the logo:  npm run icon
#
#   -Mode symbol (default)  keeps only the logo's dominant colour (the symbol), drops text/other
#                           colours, and centres it on a round badge in the logo's background colour.
#   -Mode crop              crops to everything that isn't background and masks it to a circle
#                           (for logos that are already a round image).
#   -Badge none             symbol on a transparent background instead of a round badge.
param(
  [string]$Source = "$PSScriptRoot\..\renderer\img\logo.png",
  [string]$Output = "$PSScriptRoot\..\renderer\img\icon.png",
  [ValidateSet('symbol', 'crop')][string]$Mode = 'symbol',
  [ValidateSet('circle', 'none')][string]$Badge = 'circle',
  [double]$Padding = 0.07,
  [int]$Size = 512
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class IconTools {
  static int A(int c) { return (c >> 24) & 255; }
  static int R(int c) { return (c >> 16) & 255; }
  static int G(int c) { return (c >> 8) & 255; }
  static int B(int c) { return c & 255; }
  static double Dist(int a, int b) {
    double r = R(a) - R(b), g = G(a) - G(b), bl = B(a) - B(b);
    return Math.Sqrt(r * r + g * g + bl * bl);
  }

  public static int[] Read(Bitmap bmp) {
    var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new int[bmp.Width * bmp.Height];
    for (int y = 0; y < bmp.Height; y++) Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), px, y * bmp.Width, bmp.Width);
    bmp.UnlockBits(data);
    return px;
  }

  public static Bitmap Write(int[] px, int w, int h) {
    var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    for (int y = 0; y < h; y++) Marshal.Copy(px, y * w, IntPtr.Add(data.Scan0, y * data.Stride), w);
    bmp.UnlockBits(data);
    return bmp;
  }

  // Most frequent non-background colour (4-bit buckets), averaged within its bucket.
  public static int Dominant(int[] px, int bg) {
    var counts = new Dictionary<int, int>();
    foreach (int c in px) {
      if (A(c) < 128 || Dist(c, bg) < 80) continue;
      int k = ((R(c) >> 4) << 8) | ((G(c) >> 4) << 4) | (B(c) >> 4);
      int n; counts.TryGetValue(k, out n); counts[k] = n + 1;
    }
    if (counts.Count == 0) return 0;
    int best = 0, bestCount = -1;
    foreach (var kv in counts) if (kv.Value > bestCount) { bestCount = kv.Value; best = kv.Key; }
    long sr = 0, sg = 0, sb = 0, cnt = 0;
    foreach (int c in px) {
      if (A(c) < 128) continue;
      if ((((R(c) >> 4) << 8) | ((G(c) >> 4) << 4) | (B(c) >> 4)) != best) continue;
      sr += R(c); sg += G(c); sb += B(c); cnt++;
    }
    return unchecked((int)0xFF000000) | ((int)(sr / cnt) << 16) | ((int)(sg / cnt) << 8) | (int)(sb / cnt);
  }

  // Key colour with alpha = how much each pixel is a blend of background -> key colour.
  // Blends towards other colours (text in another colour, grey captions) get alpha 0.
  public static int[] Extract(int[] px, int bg, int key) {
    double br = R(bg), bgc = G(bg), bb = B(bg);
    double vr = R(key) - br, vg = G(key) - bgc, vb = B(key) - bb;
    double l2 = vr * vr + vg * vg + vb * vb, l = Math.Sqrt(l2);
    var outPx = new int[px.Length];
    int rgb = key & 0xFFFFFF;
    for (int i = 0; i < px.Length; i++) {
      int c = px[i];
      double pr = R(c) - br, pg = G(c) - bgc, pb = B(c) - bb;
      double t = (pr * vr + pg * vg + pb * vb) / l2;
      if (t <= 0.02 || A(c) < 8) { outPx[i] = 0; continue; }
      double dr = pr - t * vr, dg = pg - t * vg, db = pb - t * vb;
      double rel = Math.Sqrt(dr * dr + dg * dg + db * db) / (t * l);
      double match = rel <= 0.08 ? 1 : rel >= 0.16 ? 0 : (0.16 - rel) / 0.08;
      int a = (int)Math.Round(Math.Min(1.0, t) * match * (A(c) / 255.0) * 255);
      outPx[i] = (a << 24) | rgb;
    }
    return outPx;
  }

  // Bounding box [minX, minY, maxX, maxY] of pixels that are visible (alphaMode) or differ from bg.
  public static int[] Bounds(int[] px, int w, int h, int bg, bool alphaMode) {
    int minX = w, minY = h, maxX = -1, maxY = -1;
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int c = px[y * w + x];
      bool on = alphaMode ? A(c) > 64 : (A(bg) < 16 ? A(c) >= 16 : (A(c) >= 16 && Dist(c, bg) >= 30));
      if (!on) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return new int[] { minX, minY, maxX, maxY };
  }
}
'@

function Square-Crop([int[]]$box) {
  $side = [math]::Max($box[2] - $box[0], $box[3] - $box[1]) + 2
  $cx = ($box[0] + $box[2]) / 2; $cy = ($box[1] + $box[3]) / 2
  [System.Drawing.RectangleF]::new($cx - $side / 2, $cy - $side / 2, $side, $side)
}

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Source))
$out = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($out)
try {
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $px = [IconTools]::Read($src)
  $bg = $px[0]
  $bgColor = [System.Drawing.Color]::FromArgb(255, [System.Drawing.Color]::FromArgb($bg))

  if ($Mode -eq 'symbol') {
    $key = [IconTools]::Dominant($px, $bg)
    if ($key -eq 0) { throw 'No symbol colour found in the logo.' }
    $symbol = [IconTools]::Write([IconTools]::Extract($px, $bg, $key), $src.Width, $src.Height)
    $box = [IconTools]::Bounds([IconTools]::Read($symbol), $src.Width, $src.Height, $bg, $true)
    if ($box[2] -lt 0) { throw 'Symbol is empty after colour extraction.' }
    if ($Badge -eq 'circle') {
      $brush = New-Object System.Drawing.SolidBrush $bgColor
      $g.FillEllipse($brush, 0, 0, $Size, $Size)
      $brush.Dispose()
    }
    $inner = $Size * (1 - 2 * $Padding)
    $dest = [System.Drawing.RectangleF]::new(($Size - $inner) / 2, ($Size - $inner) / 2, $inner, $inner)
    $g.DrawImage($symbol, $dest, (Square-Crop $box), [System.Drawing.GraphicsUnit]::Pixel)
    $symbol.Dispose()
    $detail = 'symbol colour #{0:X6}, background #{1:X6}' -f ($key -band 0xFFFFFF), ($bg -band 0xFFFFFF)
  } else {
    $box = [IconTools]::Bounds($px, $src.Width, $src.Height, $bg, $false)
    if ($box[2] -lt 0) { throw 'Logo appears to be empty (all background).' }
    $scaled = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $sg = [System.Drawing.Graphics]::FromImage($scaled)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.DrawImage($src, [System.Drawing.RectangleF]::new(0, 0, $Size, $Size), (Square-Crop $box), [System.Drawing.GraphicsUnit]::Pixel)
    $sg.Dispose()
    $brush = New-Object System.Drawing.TextureBrush $scaled
    $g.FillEllipse($brush, 0, 0, $Size, $Size)
    $brush.Dispose()
    $scaled.Dispose()
    $detail = 'cropped to content and masked to a circle'
  }

  $g.Dispose()
  $out.Save((Join-Path (Resolve-Path (Split-Path $Output)) (Split-Path $Output -Leaf)), [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host ("icon.png written ({0}x{0}, mode {1}: {2}; content x={3}..{4} y={5}..{6})" -f $Size, $Mode, $detail, $box[0], $box[2], $box[1], $box[3])
} finally {
  $out.Dispose()
  $src.Dispose()
}
