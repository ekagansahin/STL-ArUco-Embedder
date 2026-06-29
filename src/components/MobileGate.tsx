/**
 * Telefon / tablet bilgilendirme kapısı.
 *
 * Uygulama yalnızca masaüstü (Windows / macOS) için tasarlandı; dokunmatik
 * sürükleme ve 3D etkileşim mobilde desteklenmiyor. Telefon veya tablet
 * algılandığında tam ekran bir bilgilendirme gösterilir. Gerçek masaüstü
 * cihazlar (dokunmatik Windows dizüstüleri dahil) engellenmez.
 *
 * Mesaj iki dilde birden gösterilir: kullanıcı dil değiştirme düğmesine
 * (overlay'in arkasında kaldığı için) ulaşamayabilir.
 */

import { useState } from 'react'

/** Telefon veya tablet mi? Masaüstü ise (Win/Mac/Linux) false döner. */
function detectMobileOrTablet(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & {
    userAgentData?: { mobile?: boolean }
    platform?: string
  }
  const ua = navigator.userAgent || ''

  // 1) Chromium User-Agent Client Hints — en güvenilir sinyal
  if (nav.userAgentData && nav.userAgentData.mobile === true) return true

  // 2) iPadOS 13+ "masaüstü modu"nda kendini MacIntel gösterir.
  //    Çok dokunmalı + MacIntel kombinasyonu iPad'i ele verir.
  const isIPadOS =
    (nav.platform === 'MacIntel' || navigator.platform === 'MacIntel') &&
    navigator.maxTouchPoints > 1
  if (isIPadOS) return true

  // 3) Klasik UA imzası (Android telefon/tablet, iPhone, eski mobil tarayıcılar)
  if (
    /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle|BlackBerry|Opera Mini|IEMobile|Windows Phone/i.test(
      ua,
    )
  ) {
    return true
  }

  return false
}

interface MobileGateProps {
  lang: 'TR' | 'EN'
}

export default function MobileGate({ lang }: MobileGateProps) {
  // UA çalışma sırasında değişmez → tek sefer hesapla
  const [dismissed, setDismissed] = useState(false)
  const [isMobile] = useState(detectMobileOrTablet)

  if (!isMobile || dismissed) return null

  const primary = lang === 'TR'
    ? {
        title: 'Lütfen bilgisayar kullanın',
        body:
          'ArUco Embedder yalnızca masaüstü için tasarlandı. En iyi deneyim için lütfen bir Windows veya macOS bilgisayardan açın.',
        cont: 'Yine de devam et',
      }
    : {
        title: 'Please use a computer',
        body:
          'ArUco Embedder is designed for desktop only. For the best experience, please open it on a Windows or macOS computer.',
        cont: 'Continue anyway',
      }

  const secondary = lang === 'TR'
    ? {
        title: 'Please use a computer',
        body:
          'This app is designed for desktop only. Please open it on a Windows or macOS computer.',
      }
    : {
        title: 'Lütfen bilgisayar kullanın',
        body:
          'Bu uygulama yalnızca masaüstü için tasarlandı. Lütfen bir Windows veya macOS bilgisayardan açın.',
      }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-neutral-950 px-6 text-center">
      <div className="text-5xl">🖥️</div>

      <div className="space-y-2 max-w-md">
        <h1 className="text-xl font-semibold text-neutral-100">{primary.title}</h1>
        <p className="text-sm text-neutral-400">{primary.body}</p>
      </div>

      <div className="space-y-1 max-w-md border-t border-neutral-800 pt-4">
        <h2 className="text-sm font-medium text-neutral-300">{secondary.title}</h2>
        <p className="text-xs text-neutral-500">{secondary.body}</p>
      </div>

      <button
        onClick={() => setDismissed(true)}
        className="mt-2 text-xs text-neutral-500 hover:text-neutral-300 underline underline-offset-4"
      >
        {primary.cont}
      </button>
    </div>
  )
}
