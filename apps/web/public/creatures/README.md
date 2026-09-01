# Fuzzy Friends — the cast

Sixteen original creatures, four per affinity. The cast used to be Pokémon,
which is somebody else's intellectual property and cannot ship.

## The contract

`apps/web/src/creatures.ts` is the only place that names these files, and
nothing else in the app knows what a creature looks like. **The filename is the
contract:** drop `otter.png` in here, change that one `sprite` path, done. Keep
the sixteen ids exactly as they are or the roster stops resolving.

One image per creature is deliberate. `CreatureSprite` carries state with CSS
motion and a mood mark, so a single picture covers all seven states — idle,
thinking, working, searching, hurt, done, waiting. A frame set per state per
creature would multiply this folder by six and weld the state layer to one
particular pack.

## The art in here now

The shipping artwork is the set of sixteen transparent 256×256 PNGs. They were
generated specifically for this repository from the product prompt below and
do not reuse third-party characters or source artwork. They ship under the same
license as this repository.

`_generate.py` and the matching SVGs preserve the original construction set:
the silhouettes, head-to-body ratio, baseline and palette. They are useful as
editable references, while the application intentionally resolves the more
polished PNG pack.

## Getting the real art

Generate **one creature per call**, not a sheet. Sheets drift in scale and
lighting between cells and cannot be cut cleanly.

**Do this first:** generate `otter` alone, iterate until it is genuinely
charming, then use that image as the style reference for the other fifteen.
Consistency comes from a fixed reference, not from repeating adjectives.

### Fixed style block — paste verbatim into every call

> Cute original mascot character for a developer tool, single character,
> centred, front-facing.
>
> Style: modern flat vector illustration, soft rounded shapes, clean uniform
> dark outline, gentle two-tone shading, warm muted palette. Chibi proportions
> — big round head about as wide as the body, small stout body, tiny paws, no
> visible legs. Large glossy eyes with white highlights, soft cheek blush, a
> small friendly closed smile. Appealing and characterful, like a modern
> sticker pack or a Duolingo-style mascot. Clean enough to read at 24×24 px.
>
> Do not include: text, letters, background, ground shadow, props, tools,
> clothing, hats, accessories, multiple characters, photorealism, 3D render,
> harsh gradients, heavy texture, sharp teeth, angry or sad expression.
>
> Output: transparent background PNG, 256×256, character occupying ~85% of the
> frame, feet resting on an invisible baseline at the same height every time.

### Then append exactly one of these

| file | subject line to append |
| --- | --- |
| `otter.png` | A river otter. Warm mid-brown fur, small round ears, pale cream muzzle and belly. |
| `panda.png` | A giant panda. Cream-white body, black round ears, black eye patches, black arms. |
| `beaver.png` | A beaver. Golden-brown fur, tiny round ears, two visible white front teeth, wide flat paddle tail. |
| `hedgehog.png` | A hedgehog. Tan face and belly, a crown of soft olive-brown spines fanning out behind the head. |
| `fox.png` | A red fox. Orange fur, tall pointed ears with pale inner, white muzzle and chest, big curled tail. |
| `owl.png` | A small owl. Muted violet feathers, ear tufts, large pale round eye discs, small orange beak. |
| `rabbit.png` | A lop-eared rabbit. Soft pink-cream fur, two long upright ears with pink inner, pink nose. |
| `squirrel.png` | A squirrel. Rust-red fur, tiny ears, an oversized question-mark bushy tail curling up behind. |
| `penguin.png` | A round penguin chick. Deep navy back and head, white face and belly, orange beak. |
| `cat.png` | A cat. Blue-teal grey fur, pointed ears with pink inner, whiskers, pale face. |
| `raccoon.png` | A raccoon. Grey fur, round ears, dark bandit mask across the eyes, ringed tail. |
| `koala.png` | A koala. Soft lilac-grey fur, very large fluffy round ears, big dark rounded nose. |
| `bear.png` | A bear cub. Dark brown fur, small round ears, tan muzzle. |
| `hamster.png` | A hamster. Golden-yellow fur, tiny ears, full cream cheeks and belly. |
| `shiba.png` | A shiba inu puppy. Caramel-orange fur, pointed ears, white muzzle chest and paws. |
| `sloth.png` | A sloth. Sage green-grey fur, tiny ears, heavy sleepy half-closed eyelids, long slow arms. |

### Checking the result

Put all sixteen side by side at 26 px before accepting them. That is the size
they render at in the sidebar, and it is where a set falls apart: if two are
hard to tell apart, the colour is doing too little work and the silhouette is
doing none. Identity is the entire reason this cast exists.
