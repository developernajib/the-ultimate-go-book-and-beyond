import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right' | 'top-or-right'

export interface TooltipProps {
	content?: ReactNode
	children: ReactNode
	position?: TooltipPosition
	delay?: number
	className?: string
	tooltipClassName?: string
	disabled?: boolean
	as?: 'span' | 'div'
}

interface Coords {
	top: number
	left: number
	actualPosition: 'top' | 'bottom' | 'left' | 'right'
	arrowOffset: number
}

export default function Tooltip({
	content,
	children,
	position = 'bottom',
	delay = 100,
	className = '',
	tooltipClassName = '',
	disabled = false,
	as = 'span',
}: TooltipProps) {
	const [visible, setVisible] = useState(false)
	const [coords, setCoords] = useState<Coords | null>(null)
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const triggerRef = useRef<HTMLDivElement | HTMLSpanElement | null>(null)
	const tooltipRef = useRef<HTMLDivElement>(null)

	const updatePosition = useCallback(() => {
		const trigger = triggerRef.current
		if (!trigger) return

		// clientWidth excludes scrollbars on win32, innerWidth does not
		const vw = document.documentElement.clientWidth || window.innerWidth
		const vh = document.documentElement.clientHeight || window.innerHeight

		const triggerRect = trigger.getBoundingClientRect()
		if (triggerRect.width === 0 && triggerRect.height === 0) {
			setVisible(false)
			return
		}
		// Offscreen trigger: hide instead of leaving an orphan tooltip
		if (
			triggerRect.bottom < 0 ||
			triggerRect.top > vh ||
			triggerRect.right < 0 ||
			triggerRect.left > vw
		) {
			setVisible(false)
			return
		}

		const tooltip = tooltipRef.current
		const tooltipWidth = tooltip ? tooltip.offsetWidth : 120
		const tooltipHeight = tooltip ? tooltip.offsetHeight : 32

		const gap = 8
		const padding = 8

		const spaceAbove = triggerRect.top
		const spaceBelow = vh - triggerRect.bottom
		const spaceLeft = triggerRect.left
		const spaceRight = vw - triggerRect.right

		const fits = {
			top: spaceAbove >= tooltipHeight + gap + padding,
			bottom: spaceBelow >= tooltipHeight + gap + padding,
			left: spaceLeft >= tooltipWidth + gap + padding,
			right: spaceRight >= tooltipWidth + gap + padding,
		}

		// Requested side when it fits, most space otherwise
		let actualPos: 'top' | 'bottom' | 'left' | 'right' = 'bottom'
		if (position === 'top-or-right') {
			if (fits.right) {
				actualPos = 'right'
			} else if (fits.top) {
				actualPos = 'top'
			} else {
				actualPos = spaceAbove >= spaceRight ? 'top' : 'right'
			}
		} else if (fits[position]) {
			actualPos = position
		} else {
			const spaces: Record<'top' | 'bottom' | 'left' | 'right', number> = {
				top: spaceAbove,
				bottom: spaceBelow,
				left: spaceLeft,
				right: spaceRight,
			}
			actualPos = (Object.keys(spaces) as Array<'top' | 'bottom' | 'left' | 'right'>).sort(
				(a, b) => spaces[b] - spaces[a]
			)[0]
		}

		let top = 0
		let left = 0
		let arrowOffset = 0

		if (actualPos === 'top' || actualPos === 'bottom') {
			top =
				actualPos === 'top'
					? triggerRect.top - tooltipHeight - gap
					: triggerRect.bottom + gap

			const triggerCenter = triggerRect.left + triggerRect.width / 2
			const maxLeft = Math.max(padding, vw - tooltipWidth - padding)
			left = Math.max(padding, Math.min(triggerCenter - tooltipWidth / 2, maxLeft))

			const rawArrowOffset = triggerCenter - left
			arrowOffset = Math.max(14, Math.min(rawArrowOffset, Math.max(14, tooltipWidth - 14)))
			// Flipped tooltip can still overflow, clamp it
			top = Math.max(padding, Math.min(top, vh - tooltipHeight - padding))
		} else {
			left =
				actualPos === 'left'
					? triggerRect.left - tooltipWidth - gap
					: triggerRect.right + gap

			const triggerCenter = triggerRect.top + triggerRect.height / 2
			const maxTop = Math.max(padding, vh - tooltipHeight - padding)
			top = Math.max(padding, Math.min(triggerCenter - tooltipHeight / 2, maxTop))

			const rawArrowOffset = triggerCenter - top
			arrowOffset = Math.max(12, Math.min(rawArrowOffset, Math.max(12, tooltipHeight - 12)))
			// Same clamp on the other axis
			left = Math.max(padding, Math.min(left, vw - tooltipWidth - padding))
		}

		setCoords({
			top,
			left,
			actualPosition: actualPos,
			arrowOffset,
		})
	}, [position])

	const show = () => {
		if (disabled || !content) return
		if (timeoutRef.current) clearTimeout(timeoutRef.current)
		timeoutRef.current = setTimeout(() => {
			setCoords(null)
			setVisible(true)
		}, delay)
	}

	const hide = () => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current)
		setVisible(false)
		setCoords(null)
	}

	// Track scroll and resize while open, rAF-throttled
	useEffect(() => {
		if (!visible) return

		updatePosition()

		let raf = 0
		const schedule = () => {
			cancelAnimationFrame(raf)
			raf = requestAnimationFrame(updatePosition)
		}

		window.addEventListener('scroll', schedule, true)
		window.addEventListener('resize', schedule)

		// Trigger width can change under us (homepage email button swaps label on hover)
		let ro: ResizeObserver | null = null
		if (typeof ResizeObserver !== 'undefined' && triggerRef.current) {
			ro = new ResizeObserver(schedule)
			ro.observe(triggerRef.current)
		}

		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') hide()
		}
		window.addEventListener('keydown', onKey)

		return () => {
			cancelAnimationFrame(raf)
			window.removeEventListener('scroll', schedule, true)
			window.removeEventListener('resize', schedule)
			window.removeEventListener('keydown', onKey)
			ro?.disconnect()
		}
	}, [visible, updatePosition])

	useLayoutEffect(() => {
		if (visible) {
			updatePosition()
		}
	}, [visible, content, updatePosition])

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current)
		}
	}, [])

	if (!content || disabled) {
		return <>{children}</>
	}

	const triggerProps = {
		ref: (el: HTMLDivElement & HTMLSpanElement) => {
			triggerRef.current = el
		},
		onMouseEnter: show,
		onMouseLeave: hide,
		onFocus: show,
		onBlur: hide,
	}

	return (
		<>
			{as === 'div' ? (
				<div className={`relative ${className}`} {...triggerProps}>
					{children}
				</div>
			) : (
				<span
					className={`relative inline-flex items-center ${className}`}
					{...triggerProps}
				>
					{children}
				</span>
			)}

			{/* Mounted only while open, opacity fades in, position snaps */}
			{typeof document !== 'undefined' &&
				visible &&
				createPortal(
					<div
						ref={tooltipRef}
						role="tooltip"
						style={{
							position: 'fixed',
							top: coords ? `${coords.top}px` : undefined,
							left: coords ? `${coords.left}px` : undefined,
							visibility: coords ? 'visible' : 'hidden',
						}}
						className={`z-[9999] w-max max-w-[calc(100vw-16px)] pointer-events-none select-none transition-opacity duration-150 ease-out ${
							coords ? 'opacity-100' : 'opacity-0'
						} ${tooltipClassName}`}
					>
						<div className="relative w-max max-w-[min(20rem,calc(100vw-16px))] rounded-lg border border-primary/30 bg-base-300 px-2.5 py-1 text-xs font-medium text-base-content shadow-[0_4px_20px_rgba(0,0,0,0.25)] backdrop-blur-md whitespace-normal break-words text-center">
							{content}

							{coords && coords.actualPosition === 'bottom' && (
								<span
									className="absolute w-2.5 h-2.5 rotate-45 bg-base-300 border-t border-l border-primary/30 -top-[6px] -translate-x-1/2"
									style={{ left: `${coords.arrowOffset}px` }}
									aria-hidden="true"
								/>
							)}

							{coords && coords.actualPosition === 'top' && (
								<span
									className="absolute w-2.5 h-2.5 rotate-45 bg-base-300 border-b border-r border-primary/30 -bottom-[6px] -translate-x-1/2"
									style={{ left: `${coords.arrowOffset}px` }}
									aria-hidden="true"
								/>
							)}

							{coords && coords.actualPosition === 'left' && (
								<span
									className="absolute w-2.5 h-2.5 rotate-45 bg-base-300 border-t border-r border-primary/30 -right-[6px] -translate-y-1/2"
									style={{ top: `${coords.arrowOffset}px` }}
									aria-hidden="true"
								/>
							)}

							{coords && coords.actualPosition === 'right' && (
								<span
									className="absolute w-2.5 h-2.5 rotate-45 bg-base-300 border-b border-l border-primary/30 -left-[6px] -translate-y-1/2"
									style={{ top: `${coords.arrowOffset}px` }}
									aria-hidden="true"
								/>
							)}
						</div>
					</div>,
					document.body
				)}
		</>
	)
}
