# Browser test media

`native-video.mp4` is a synthetic black 16 × 16 video, 551 seconds long at one frame per second. It contains no third-party material or audio.

The browser check needs real media metadata and seeking behavior shared by a page and an extension content script. JavaScript mocks on a page do not override the media properties in Chrome's isolated content-script world.

Generated once using:

```sh
ffmpeg -f lavfi -i color=c=black:s=16x16:r=1 -t 551 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart native-video.mp4
```

FFmpeg is not needed to run the check with the included fixture.
