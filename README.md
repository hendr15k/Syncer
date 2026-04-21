# Syncer — AI Multi-Speaker Stage Reader

> Ladet PDFs, EPUBs oder Plain Text hoch und lasst sie euch als Bühenshow mit Szenen-Bildern vorlesen.

**Multi-Speaker TTS** mit Gemini — jeder Absatz wird automatisch einem anderen Voice zugewiesen, um ein Hörbuch-Erlebnis mit mehreren Sprechern zu erzeugen. Optional können Szenen-Bilder per Gemini generiert werden.

## Features

- **Multi-Speaker TTS** — Absätze automatisch auf mehrere Stimmen verteilt
- **Szenen-Bilder** — Gemini generiert passende Bilder zum Textabschnitt
- **Voice Selection** — Wählt zwischen verschiedenen TTS-Stimmen
- **PDF/EPUB/TXT Support** — Dateien hochladen oder Text direkt einfügen
- **Playback Controls** — Play/Pause, Speed, Chapter Jump

## Run Locally

```bash
npm install
npm run dev
```

**Benötigt:** `GEMINI_API_KEY` in [.env.local](.env.local)

## Tech Stack

React 19 + TypeScript + TailwindCSS + Gemini TTS API

## Links

- [AI Studio App](https://ai.studio/apps/drive/19Yc0OWX1jYNJArHsb0GTK-BKfN2B_29P) — Original Gemini Studio Projekt
- [Validate CI](https://github.com/hendr15k/Syncer/actions/workflows/validate.yml)

[![Validate](https://github.com/hendr15k/Syncer/actions/workflows/validate.yml/badge.svg)](https://github.com/hendr15k/Syncer/actions/workflows/validate.yml)