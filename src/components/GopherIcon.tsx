interface GopherIconProps {
    size?: number
    className?: string
}

export default function GopherIcon({ size = 24, className = '' }: GopherIconProps) {
    return (
        <img
            src="/gopher.svg"
            alt="Go Gopher"
            width={size}
            height={size}
            className={`inline-block ${className}`}
        />
    )
}
