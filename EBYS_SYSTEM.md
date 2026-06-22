# EBYS — Eat Bugs You Spider!

EBYS est une webradio générative autonome et un répertoire d'événements musicaux montréalais. Les deux systèmes sont liés : le site recense la scène, la radio en est la bande sonore permanente.

---

## 1. Répertoire d'événements

Un site web de recensement des événements musicaux montréalais — shows, soirées, concerts, performances. Web-scraped et alimenté manuellement par la communauté.

### Principes

- Pas de compte utilisateur obligatoire
- Pas de rétention de données personnelles
- Pas d'algorithme de recommandation
- Pas de hiérarchie éditoriale
- Conformité légale : cookies, vie privée, normes applicables

### Filtrage

- Par genre musical
- Par date / lieu
- Par artiste

### Upload audio

Les artistes peuvent soumettre leurs pistes audio directement depuis le site. Ces soumissions alimentent la bibliothèque de Cricket et deviennent matière première pour la radio générative.

Enjeux à résoudre :
- Durée de conservation des fichiers audio soumis
- Droits et responsabilités légales sur le contenu uploadé
- Système sans overhead : pas de comptes, pas de données conservées inutilement

---

## 2. Radio générative (Cricket)

La radio est un flux audio continu généré par Cricket — l'instrument de remixage neuronal. Elle tourne en fond du site, sans intervention humaine.

### Comportement

- Flux continu, sans tracklist fixe
- Remixage probabilistique en temps réel à partir des pistes soumises
- Sélection pilotée par les descripteurs audio [M, E, F, P, H, T]
- Pas de répétition exacte

### États internes

- Niveau d'énergie
- Densité spectrale
- Balance tonale
- Intensité rythmique

Ces états influencent la sélection des slices en continu.

### What Triggers the Remixing Engine

During the day the radio plays pure tracks — single artists, unaltered. The remixing engine is dormant. Something has to wake it.

The most honest trigger is the city itself. Montreal's weather feeds directly into the engine — rain, temperature, wind, storm pressure. A clear afternoon stays pure. A storm at night activates the collage. The music changes because the city changed.

Weather is the conductor. The radio is the orchestra.

Other possible triggers — to be defined:
- Time of day (night as default remixing window)
- Number of active listeners
- Manual override by a curator
- Random probability that drifts in and out

These can stack. Weather + night + high listener count = maximum generative complexity.

### Relation avec le répertoire

La radio n'est pas séparée du site — elle en est le fond sonore vivant. Les artistes qui soumettent leurs pistes au répertoire alimentent directement la radio. La scène montréalaise devient sa propre bande sonore.

---

## 3. Interface (UI/UX)

### Structure de base

L'interface web est construite sans style par défaut — HTML brut, zéro CSS. Les skins transforment complètement l'apparence.

### Système de skins

- Une skin = un fichier CSS
- Les utilisateurs peuvent créer et partager leurs propres skins
- Aucune installation requise — juste un fichier CSS à charger
- Compatibilité totale avec l'esthétique terminal (monospace, fond sombre) ou n'importe quelle direction visuelle

### Légèreté

- Pas de framework lourd
- Pas d'overhead
- Tourne dans le navigateur
- Compatible desktop et mobile

---

## 4. Modèle économique

- Accès libre, aucune barrière
- Bouton de don volontaire (Ko-fi, Liberapay, ou Stripe direct)
- Les dons soutiennent l'infrastructure, pas le contenu

---

## 5. Licence

© Eat Bugs You Spider!
Distribué sous licence GNU Affero General Public License v3.0 (AGPL-3.0).
Le code est public. La radio est ouverte. La scène est à tout le monde.

https://www.gnu.org/licenses/agpl-3.0.html
