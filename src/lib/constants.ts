export const GITHUB_REPO_URL = 'https://github.com/developernajib/the-ultimate-go-book-and-beyond'
export const GITHUB_REPO_HANDLE = 'github.com/developernajib/the-ultimate-go-book-and-beyond'

export function getGitHubIssueUrl(title: string): string {
	return `${GITHUB_REPO_URL}/issues/new?title=${encodeURIComponent(title)}`
}
