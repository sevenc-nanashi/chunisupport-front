import { Dialog } from '@kobalte/core/dialog'
import { Clipboard, ClipboardCheck, Download, ImageDown, Share2, X } from 'lucide-solid'
import type { Component } from 'solid-js'
import { createEffect, createSignal, Match, onCleanup, Show, Switch, untrack } from 'solid-js'
import { Loading } from '../../../../components'
import {
  AppButton,
  getAppButtonClass,
  getAppIconButtonClass,
} from '../../../../components/common/AppButton'
import { RATING_SLOT_COUNT } from '../../../../constants/rating'
import { SOCIAL_SHARE_TEXT } from '../../../../constants/socialShare'
import type { HonorDTO, PlayerDTO, UserRatingDTO } from '../../../../types/api'
import {
  canShareFiles,
  captureElementAsImage,
  copyImageFileToClipboard,
  downloadBlobFile,
} from '../../../../utils/domImageCapture'
import { buildChunithmJacketUrl } from '../../../../utils/jacket'
import {
  RATING_IMAGE_COPY,
  RATING_IMAGE_JPEG_QUALITY,
  RATING_IMAGE_PIXEL_RATIO,
  RATING_IMAGE_WIDTH_PX,
} from '../UserProfileView.constants'
import { RatingImageSheet } from './RatingImageSheet'
import { formatRatingImageFilename } from './ratingImageFilename'

type Props = {
  /** プロフィールURLに使用するユーザー名 */
  username: string
  /** 画像上部へ表示するプレイヤー情報 */
  playerInfo: PlayerDTO
  /** 画像上部へ表示する称号 */
  honors: HonorDTO[]
  /** ベスト枠・新曲枠と集計値 */
  rating: UserRatingDTO
  /** カード背景へジャケット画像を表示するかどうか */
  showJackets: boolean
}

/**
 * ベスト枠・新曲枠画像を縮小プレビューし、JPEGとして共有・保存できるダイアログを表示する。
 *
 * @param props - プレイヤー情報、称号、レーティング枠、ジャケット表示設定。
 * @returns 画像化プレビューを開くボタンとダイアログ。
 */
export const RatingImagePreviewDialog: Component<Props> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [isDownloading, setIsDownloading] = createSignal(false)
  const [isPreparingShare, setIsPreparingShare] = createSignal(false)
  const [isSharing, setIsSharing] = createSignal(false)
  // クリップボードはコピーされたことがわかりにくいので、一回コピーボタンを押したら
  // コピー済の表示をするようにする
  const [copyState, setCopyState] = createSignal<'idle' | 'copying' | 'copied'>('idle')
  const [shareImageFile, setShareImageFile] = createSignal<File>()
  const [imageActionError, setImageActionError] = createSignal<string>()
  const [previewViewport, setPreviewViewport] = createSignal<HTMLDivElement>()
  const [imageSheet, setImageSheet] = createSignal<HTMLDivElement>()
  const [previewScale, setPreviewScale] = createSignal(1)

  const [readyJacketCount, setReadyJacketCount] = createSignal(0)
  const readyJacketKeys = new Set<string>()

  /**
   * 画像化対象に含まれる、URLが有効なジャケット画像の件数を返す。
   *
   * @returns 読み込み完了を待つジャケット画像の件数。
   */
  const expectedJacketCount = (): number => {
    if (!props.showJackets) return 0

    return [
      ...props.rating.best.slice(0, RATING_SLOT_COUNT.best),
      ...props.rating.new.slice(0, RATING_SLOT_COUNT.new),
    ].filter((record) => buildChunithmJacketUrl(record.img) !== null).length
  }

  /**
   * 全ジャケットが元画像またはプレースホルダーで表示可能になったかを返す。
   *
   * @returns プレビューを表示可能な場合はtrue。
   */
  const isPreviewReady = (): boolean => readyJacketCount() >= expectedJacketCount()

  /**
   * ダウンロード・共有・共有用画像生成のいずれかを実行中か返す。
   *
   * @returns 画像に関する処理を実行中の場合はtrue。
   */
  const isImageActionRunning = (): boolean => isDownloading() || isPreparingShare() || isSharing()

  /**
   * 現在のブラウザがJPEGファイルの共有に対応しているかを返す。
   *
   * @returns Web Share APIでJPEGファイルを共有できる場合はtrue。
   */
  const canShareRatingImage = (): boolean =>
    canShareFiles([new File([], 'share-test.jpg', { type: 'image/jpeg' })])

  /**
   * ジャケット画像ごとの準備状態を集約する。
   *
   * @param key - 画像化対象内でジャケット画像を識別するキー。
   * @param ready - 元画像またはプレースホルダーを表示可能かどうか。
   * @returns なし。
   */
  const handleJacketReadyChange = (key: string, ready: boolean): void => {
    if (ready) {
      readyJacketKeys.add(key)
    } else {
      readyJacketKeys.delete(key)
    }
    setReadyJacketCount(readyJacketKeys.size)
  }

  /**
   * ダイアログの開閉状態を更新し、閉じるときは一時エラーを破棄する。
   *
   * @param nextOpen - 次のダイアログ開閉状態。
   * @returns なし。
   */
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && isImageActionRunning()) return

    if (nextOpen) {
      readyJacketKeys.clear()
      setReadyJacketCount(0)
      setShareImageFile(undefined)
      setCopyState('idle')
    }
    setOpen(nextOpen)
    if (!nextOpen) setImageActionError(undefined)
  }

  /**
   * 現在のプレビュー内容を原寸解像度のJPEGファイルとして生成する。
   *
   * @returns ファイル名を設定したJPEGファイル。
   */
  const createRatingImageFile = async (): Promise<File> => {
    const sheet = imageSheet()
    if (!sheet) throw new Error('Rating image sheet is not ready')

    const blob = await captureElementAsImage(sheet, {
      format: 'jpeg',
      pixelRatio: RATING_IMAGE_PIXEL_RATIO,
      quality: RATING_IMAGE_JPEG_QUALITY,
    })

    return new File([blob], formatRatingImageFilename(props.username), { type: 'image/jpeg' })
  }

  /**
   * Web Share APIのユーザー操作を保てるよう、共有用画像を事前生成する。
   *
   * @returns 画像生成処理の完了時に解決されるPromise。
   */
  const prepareShareImage = async (): Promise<void> => {
    if (isPreparingShare() || shareImageFile()) return

    setIsPreparingShare(true)
    setImageActionError(undefined)

    try {
      setShareImageFile(await createRatingImageFile())
    } catch {
      setShareImageFile(undefined)
      setImageActionError(RATING_IMAGE_COPY.shareError)
    } finally {
      setIsPreparingShare(false)
    }
  }

  /**
   * 現在のプレビュー内容を原寸解像度のJPEGとしてダウンロードする。
   *
   * @returns ダウンロード処理の完了時に解決されるPromise。
   */
  const downloadRatingImage = async (): Promise<void> => {
    setIsDownloading(true)
    setImageActionError(undefined)

    try {
      const imageFile = await createRatingImageFile()
      downloadBlobFile(imageFile, imageFile.name)
    } catch {
      setImageActionError(RATING_IMAGE_COPY.downloadError)
    } finally {
      setIsDownloading(false)
    }
  }

  /**
   * 現在のプレビュー画像をWeb Share APIで共有する。
   *
   * @returns 共有処理の完了時に解決されるPromise。
   */
  const shareRatingImage = async (): Promise<void> => {
    const imageFile = shareImageFile()
    if (!imageFile) {
      void prepareShareImage()
      return
    }
    if (!canShareFiles([imageFile])) {
      setImageActionError(RATING_IMAGE_COPY.shareError)
      return
    }

    setIsSharing(true)
    setImageActionError(undefined)

    try {
      await navigator.share({
        files: [imageFile],
        text: SOCIAL_SHARE_TEXT,
        title: RATING_IMAGE_COPY.dialogTitle,
      })
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setImageActionError(RATING_IMAGE_COPY.shareError)
      }
    } finally {
      setIsSharing(false)
    }
  }

  /**
   * 現在のプレビュー画像をクリップボードにコピーする。
   *
   * @returns コピー処理の完了時に解決されるPromise。
   */
  const copyRatingImageToClipboard = async (): Promise<void> => {
    const imageFile = shareImageFile()
    if (!imageFile) {
      void prepareShareImage()
      return
    }

    setCopyState('copying')
    setImageActionError(undefined)

    try {
      await copyImageFileToClipboard(imageFile)
      setCopyState('copied')
    } catch {
      setImageActionError(RATING_IMAGE_COPY.shareError)
      setCopyState('idle')
    }
  }

  // 共有ダイアログをクリック直後に開けるよう、プレビュー完成時点でファイルを準備する。
  createEffect(() => {
    if (!open() || !isPreviewReady()) return

    untrack(() => void prepareShareImage())
  })

  // 画像の論理サイズを保存したまま、プレビューだけをダイアログの表示領域へ収める。
  createEffect(() => {
    if (!open()) return

    const viewport = previewViewport()
    const sheet = imageSheet()
    if (!viewport || !sheet) return

    /**
     * 画像本体を表示領域の幅と高さへ収める縮小率を更新する。
     *
     * @returns なし。
     */
    let animationFrameId: number | undefined

    const updatePreviewSize = (): void => {
      if (animationFrameId !== undefined) cancelAnimationFrame(animationFrameId)

      animationFrameId = requestAnimationFrame(() => {
        const scale = Math.min(
          1,
          viewport.clientWidth / RATING_IMAGE_WIDTH_PX,
          viewport.clientHeight / sheet.offsetHeight
        )

        setPreviewScale((current) => (current === scale ? current : scale))
        animationFrameId = undefined
      })
    }

    const resizeObserver = new ResizeObserver(updatePreviewSize)
    resizeObserver.observe(viewport)
    resizeObserver.observe(sheet)
    updatePreviewSize()

    onCleanup(() => {
      resizeObserver.disconnect()
      if (animationFrameId !== undefined) cancelAnimationFrame(animationFrameId)
    })
  })

  return (
    <Dialog open={open()} onOpenChange={handleOpenChange} preventScroll={false}>
      <Dialog.Trigger
        as="button"
        type="button"
        class={getAppButtonClass({
          variant: 'surface',
          shape: 'pill',
          class: 'h-10 focus-visible:ring-offset-2',
        })}
      >
        <ImageDown class="h-5 w-5" aria-hidden="true" />
        <span>{RATING_IMAGE_COPY.openPreview}</span>
      </Dialog.Trigger>
      <Show when={open()}>
        <Dialog.Portal>
          <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay" />
          <Dialog.Content class="fixed inset-x-4 top-4 bottom-4 z-60 flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-lg bg-surface p-4 shadow-lg sm:left-1/2 sm:right-auto sm:top-1/2 sm:bottom-auto sm:h-[92dvh] sm:max-h-[92dvh] sm:w-[94vw] sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:p-6">
            <div class="flex shrink-0 items-start justify-between gap-4">
              <div class="min-w-0">
                <Dialog.Title class="text-lg font-bold text-text">
                  {RATING_IMAGE_COPY.dialogTitle}
                </Dialog.Title>
                <Dialog.Description class="mt-1 text-sm text-text-muted">
                  {RATING_IMAGE_COPY.dialogDescription}
                </Dialog.Description>
              </div>
              <Dialog.CloseButton
                class={getAppIconButtonClass({ tone: 'ghost', class: 'shrink-0' })}
                aria-label={RATING_IMAGE_COPY.close}
                disabled={isImageActionRunning()}
              >
                <X class="h-5 w-5" aria-hidden="true" />
              </Dialog.CloseButton>
            </div>

            <div class="mt-4 min-h-0 flex-1 basis-0 overflow-hidden rounded-md bg-bg p-3">
              <div
                ref={(element) => setPreviewViewport(element)}
                class="relative mx-auto h-full w-full overflow-hidden"
              >
                <Show when={!isPreviewReady()}>
                  <div class="absolute inset-0 z-10">
                    <Loading ariaLabel={RATING_IMAGE_COPY.preparingPreview} />
                  </div>
                </Show>
                <div
                  class="absolute left-1/2 top-1/2 select-none"
                  classList={{ invisible: !isPreviewReady() }}
                  aria-busy={!isPreviewReady()}
                  style={{
                    transform: `translate(-50%, -50%) scale(${previewScale()})`,
                    'transform-origin': 'center',
                  }}
                >
                  <RatingImageSheet
                    captureRef={(element) => setImageSheet(element)}
                    playerInfo={props.playerInfo}
                    honors={props.honors}
                    rating={props.rating}
                    showJackets={props.showJackets}
                    onJacketReadyChange={handleJacketReadyChange}
                  />
                </div>
              </div>
            </div>

            <div class="mt-4 flex shrink-0 flex-col items-end gap-2">
              <Show when={imageActionError()}>
                {(message) => (
                  <p class="text-sm text-danger" role="alert">
                    {message()}
                  </p>
                )}
              </Show>
              <div class="flex flex-wrap justify-end gap-2">
                <Show
                  when={canShareRatingImage()}
                  fallback={
                    <AppButton
                      variant="secondary"
                      disabled={isImageActionRunning() || !isPreviewReady()}
                      aria-busy={isPreparingShare() || copyState() === 'copying'}
                      onClick={copyRatingImageToClipboard}
                      leftIcon={
                        <Switch>
                          <Match when={isPreparingShare() || copyState() === 'copying'}>
                            <Loading size="inline" ariaHidden />
                          </Match>
                          <Match when={copyState() === 'copied'}>
                            <ClipboardCheck class="h-4 w-4" aria-hidden="true" />
                          </Match>
                          <Match when={copyState() === 'idle'}>
                            <Clipboard class="h-4 w-4" aria-hidden="true" />
                          </Match>
                        </Switch>
                      }
                    >
                      {isPreparingShare()
                        ? RATING_IMAGE_COPY.preparingShare
                        : copyState() === 'copying'
                          ? RATING_IMAGE_COPY.copying
                          : copyState() === 'copied'
                            ? RATING_IMAGE_COPY.copied
                            : RATING_IMAGE_COPY.copy}
                    </AppButton>
                  }
                >
                  <AppButton
                    variant="secondary"
                    disabled={isImageActionRunning() || !isPreviewReady()}
                    aria-busy={isPreparingShare() || isSharing()}
                    onClick={shareRatingImage}
                    leftIcon={
                      <Show
                        when={!isPreparingShare() && !isSharing()}
                        fallback={<Loading size="inline" ariaHidden />}
                      >
                        <Share2 class="h-4 w-4" aria-hidden="true" />
                      </Show>
                    }
                  >
                    {isPreparingShare()
                      ? RATING_IMAGE_COPY.preparingShare
                      : isSharing()
                        ? RATING_IMAGE_COPY.sharing
                        : RATING_IMAGE_COPY.share}
                  </AppButton>
                </Show>
                <AppButton
                  variant="primary"
                  disabled={isImageActionRunning() || !isPreviewReady()}
                  aria-busy={isDownloading()}
                  onClick={downloadRatingImage}
                  leftIcon={
                    <Show when={!isDownloading()} fallback={<Loading size="inline" ariaHidden />}>
                      <Download class="h-4 w-4" aria-hidden="true" />
                    </Show>
                  }
                >
                  {isDownloading() ? RATING_IMAGE_COPY.downloading : RATING_IMAGE_COPY.download}
                </AppButton>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Show>
    </Dialog>
  )
}
