import type {
  HealthResult,
  ReferenceAsset,
  ReferenceGroup,
  ReferenceStyle,
  SearchRequest,
  SearchResponse,
} from '../lib/types'

const styles: ReferenceStyle[] = ['Manga / anime', 'Western ink', 'Realistic', 'Cartoon', 'Gesture']
const scopes = ['Eye study', 'Face construction', 'Hair silhouette', 'Hand gesture', 'Standing figure', 'Two-character pose']

function svgData(id: number, label: string) {
  const variants = [
    `<path d="M24 63 Q60 25 96 63 Q60 87 24 63ZM49 60a12 12 0 1 0 24 0 12 12 0 1 0-24 0"/><path d="M28 50 Q61 18 93 48"/>`,
    `<ellipse cx="60" cy="42" rx="27" ry="31"/><path d="M33 47 Q22 86 37 103M87 47Q99 84 84 104M45 52Q60 62 75 52M50 74Q60 79 70 74"/>`,
    `<circle cx="60" cy="31" r="15"/><path d="M59 46Q37 61 34 96M60 47Q85 60 88 97M35 72L18 93M86 72L105 93M49 95L39 121M71 95L81 121"/>`,
    `<path d="M31 93Q35 47 58 31Q81 45 89 93M43 53Q60 35 78 54M37 73Q59 92 84 72M48 91L43 119M73 91L80 119"/>`,
    `<path d="M27 93Q28 58 48 50L45 23Q68 27 75 51Q95 61 91 94M39 70Q60 84 80 68M42 92L32 115M78 91L91 113"/>`,
  ]
  const shape = variants[id % variants.length]
  const rotation = (id % 5 - 2) * 2
  const hatch = id % 2
    ? `<path d="M19 111L42 88M31 119L52 98M76 101L94 83M84 115L105 94" opacity=".26"/>`
    : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="300" viewBox="0 0 120 150"><rect width="120" height="150" fill="#f4f1ea"/><g fill="none" stroke="#202124" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" transform="rotate(${rotation} 60 75)">${shape}${hatch}</g><text x="60" y="139" text-anchor="middle" font-family="sans-serif" font-size="6" fill="#74716b">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export const fixtureAssets: ReferenceAsset[] = Array.from({ length: 30 }, (_, index) => {
  const style = styles[index % styles.length] ?? 'Gesture'
  const scope = scopes[index % scopes.length] ?? 'Figure study'
  return {
    id: `fixture-${index + 1}`,
    title: `${scope} ${String(index + 1).padStart(2, '0')}`,
    imageUrl: svgData(index, scope),
    style,
    scope,
    source: 'drawable procedural fixture',
    native: index % 3 !== 0,
    match: index % 4 === 0 ? 'Strong' : index % 3 === 0 ? 'Related' : 'Close',
    traceAllowed: true,
  }
})

function take(offset: number, count: number) {
  return Array.from({ length: count }, (_, index) => fixtureAssets[(offset + index) % fixtureAssets.length]).filter(Boolean) as ReferenceAsset[]
}

const confidentGroups = (): ReferenceGroup[] => [
  { id: 'best', title: 'Best match', results: take(0, 6) },
  ...styles.map((style, index) => ({
    id: style.toLowerCase().replaceAll(/[^a-z]+/g, '-'),
    title: style,
    results: take(index * 5, 4).filter((asset) => asset.style === style || index === 0),
  })),
]

const provisionalGroups = (): ReferenceGroup[] => [
  { id: 'eye', title: 'Possibly an eye', tentative: true, results: take(0, 4) },
  { id: 'face', title: 'Possibly a face', tentative: true, results: take(5, 4) },
  { id: 'gesture', title: 'Possibly a gesture', tentative: true, results: take(10, 4) },
]

export async function fixtureSearch(request: SearchRequest, signal: AbortSignal): Promise<SearchResponse> {
  const lowerHint = request.textHint.toLowerCase()
  const delay = lowerHint.includes('slow') ? 1500 : 320
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, delay)
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(new DOMException('Search cancelled', 'AbortError'))
    }, { once: true })
  })
  if (lowerHint.includes('error')) throw new Error('The fixture search was asked to fail.')
  const base = { revision: request.revision, generation: request.generation }
  if (request.strokeCount === 0) {
    return { ...base, mode: 'empty', interpretation: 'Blank canvas', groups: [] }
  }
  if (lowerHint.includes('empty')) {
    return { ...base, mode: 'insufficient', interpretation: 'No relevant candidates', groups: [] }
  }
  if (request.strokeCount < 3) {
    return { ...base, mode: 'provisional', interpretation: 'Reading early marks', groups: provisionalGroups() }
  }
  return { ...base, mode: 'confident', interpretation: lowerHint || 'Character figure', groups: confidentGroups() }
}

export const fixtureHealth: HealthResult = {
  mode: 'fixture',
  ready: true,
  message: 'Procedural references · no backend required',
}
