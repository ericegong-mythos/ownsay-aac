#!/usr/bin/env node
// Diagnose horizontal overflow: report scrollWidth and offending elements.
import { chromium } from '@playwright/test'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/'
const width = Number(process.argv[3] ?? 375)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width, height: 800 } })
await page.goto(url, { waitUntil: 'networkidle' })
const report = await page.evaluate(() => {
  const doc = document.documentElement
  const offenders = []
  for (const el of document.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect()
    if (rect.right > doc.clientWidth + 1 || rect.width > doc.clientWidth + 1) {
      offenders.push({
        tag: el.tagName,
        cls: String(el.className?.baseVal ?? el.className).slice(0, 60),
        w: Math.round(rect.width),
        right: Math.round(rect.right),
      })
    }
  }
  return {
    clientWidth: doc.clientWidth,
    scrollWidth: doc.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    offenders: offenders.slice(0, 25),
  }
})
console.log(JSON.stringify(report, null, 2))
await browser.close()
