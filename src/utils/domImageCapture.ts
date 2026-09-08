/** DOM画像化時にCanvasの一辺へ許容する最大CSSピクセル数 */
const DEFAULT_IMAGE_CAPTURE_MAX_CSS_SIDE = 8_000
/** ダウンロード開始後にObject URLを解放するまでの待機時間 */
const IMAGE_OBJECT_URL_REVOKE_DELAY_MS = 1_000
/** DOM画像へ含めない要素を指定するデータ属性セレクター */
const IMAGE_CAPTURE_EXCLUDED_SELECTOR = '[data-image-capture-excluded="true"]'

type ImageCaptureOptions = {
  /** ラスター画像へ出力するときのデバイスピクセル比 */
  pixelRatio: number
  /** 出力するラスター画像形式 */
  format: 'png' | 'jpeg'
  /** JPEG出力時の圧縮品質 */
  quality?: number
  /** 画像化用DOMの一辺へ許容する最大CSSピクセル数 */
  maxCssSide?: number
}

type ImageCaptureTarget = {
  /** SnapDOMへ渡す、画面表示用transformを持たない要素 */
  element: HTMLDivElement
  /** 画像化用に追加した一時DOMを破棄する処理 */
  dispose: () => void
}

/**
 * 元要素をCanvas上限内へ収めるための縮小率を計算する。
 *
 * @param width - 元要素の論理幅。
 * @param height - 元要素の論理高さ。
 * @param maxCssSide - 許容する最大CSSピクセル数。
 * @returns 1以下の画像化用縮小率。
 */
export const calculateImageCaptureScale = (
  width: number,
  height: number,
  maxCssSide: number = DEFAULT_IMAGE_CAPTURE_MAX_CSS_SIDE
): number => Math.min(1, maxCssSide / width, maxCssSide / height)

/**
 * 画像化対象を祖先の表示用transformから切り離し、固定寸法で複製する。
 *
 * @param sourceElement - 画面に表示中の画像化対象。
 * @param maxCssSide - 画像化用DOMの一辺へ許容する最大CSSピクセル数。
 * @returns 画像化対象の複製と破棄処理。
 */
const createImageCaptureTarget = (
  sourceElement: HTMLElement,
  maxCssSide: number
): ImageCaptureTarget => {
  const sourceWidth = sourceElement.offsetWidth
  const captureHost = document.createElement('div')
  const captureElement = document.createElement('div')
  const sourceClone = sourceElement.cloneNode(true) as HTMLElement

  sourceClone.querySelectorAll(IMAGE_CAPTURE_EXCLUDED_SELECTOR).forEach((element) => {
    element.remove()
  })

  Object.assign(captureHost.style, {
    left: '-100000px',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
  })
  Object.assign(sourceClone.style, {
    maxWidth: 'none',
    width: `${sourceWidth}px`,
  })
  captureHost.setAttribute('aria-hidden', 'true')
  captureElement.appendChild(sourceClone)
  captureHost.appendChild(captureElement)
  document.body.appendChild(captureHost)

  const sourceHeight = sourceClone.offsetHeight
  const captureScale = calculateImageCaptureScale(sourceWidth, sourceHeight, maxCssSide)

  Object.assign(captureElement.style, {
    height: `${Math.ceil(sourceHeight * captureScale)}px`,
    overflow: 'hidden',
    width: `${Math.ceil(sourceWidth * captureScale)}px`,
  })
  Object.assign(sourceClone.style, {
    transform: `scale(${captureScale})`,
    transformOrigin: 'top left',
  })

  return {
    element: captureElement,
    dispose: () => captureHost.remove(),
  }
}

/**
 * 要素内の読み込み済み画像がデコード可能になるまで待つ。
 *
 * @param element - 画像を含む画像化対象。
 * @returns すべての画像のデコード試行が完了したときに解決されるPromise。
 */
const waitForElementImages = async (element: HTMLElement): Promise<void> => {
  const images = Array.from(element.querySelectorAll('img'))
  await Promise.all(images.map((image) => image.decode().catch(() => undefined)))
}

/**
 * 表示中のDOM要素をテーマと埋め込みフォントを維持したラスター画像へ変換する。
 *
 * @param sourceElement - ラスター画像へ変換する表示中のDOM要素。
 * @param options - 出力形式、ピクセル比、品質、Canvas上限。
 * @returns 生成した画像Blob。
 */
export const captureElementAsImage = async (
  sourceElement: HTMLElement,
  options: ImageCaptureOptions
): Promise<Blob> => {
  await Promise.all([document.fonts.ready, waitForElementImages(sourceElement)])
  const capture = createImageCaptureTarget(
    sourceElement,
    options.maxCssSide ?? DEFAULT_IMAGE_CAPTURE_MAX_CSS_SIDE
  )

  try {
    const { snapdom } = await import('@zumer/snapdom')
    const captureResult = await snapdom(capture.element, {
      backgroundColor: getComputedStyle(sourceElement).backgroundColor,
      dpr: options.pixelRatio,
      embedFonts: true,
      format: options.format,
      quality: options.quality,
      reconcile: true,
    })
    const rasterizeOptions = {
      dpr: options.pixelRatio,
      quality: options.quality,
      type: options.format,
    }

    // ChromeがSVG内の埋め込みフォントを初回描画で準備するため、1回目は破棄する。
    await captureResult.toBlob(rasterizeOptions)
    return captureResult.toBlob(rasterizeOptions)
  } finally {
    capture.dispose()
  }
}

/**
 * Blobを指定ファイル名でダウンロードする。
 *
 * @param blob - ダウンロードするファイル内容。
 * @param filename - ダウンロード時に使用する拡張子付きファイル名。
 * @returns なし。
 */
export const downloadBlobFile = (blob: Blob, filename: string): void => {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.download = filename
  link.href = objectUrl
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), IMAGE_OBJECT_URL_REVOKE_DELAY_MS)
}

/**
 * クリップボードへ画像をコピーする。
 *
 * @param blob - コピーする画像のBlob。
 * @returns なし。
 */
export const copyImageFileToClipboard = async (blob: Blob): Promise<void> => {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard === 'undefined') {
    throw new Error('Clipboard API is not available.')
  }
  // NOTE: 画像コピーはimage/pngのほうが都合がいいので、image/jpegはimage/pngに変換してコピーする。
  if (blob.type === 'image/jpeg') {
    const imageBitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = imageBitmap.width
    canvas.height = imageBitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Failed to get 2D context from canvas.')
    }
    ctx.drawImage(imageBitmap, 0, 0)
    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!pngBlob) {
      throw new Error('Failed to convert JPEG to PNG.')
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': pngBlob,
      }),
    ])
  } else if (blob.type === 'image/png') {
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blob,
      }),
    ])
  } else {
    throw new Error(`Unsupported image type: ${blob.type}`)
  }
}

/**
 * 現在のブラウザが指定ファイルのWeb Share API共有に対応しているかを返す。
 *
 * @param files - 共有可否を確認するファイル。
 * @returns 指定ファイルを共有できる場合はtrue。
 */
export const canShareFiles = (files: File[]): boolean =>
  typeof navigator !== 'undefined' &&
  typeof navigator.share === 'function' &&
  typeof navigator.canShare === 'function' &&
  navigator.canShare({ files })
