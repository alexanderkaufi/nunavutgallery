Eine Webseite, die das Instagram-Konto moeglichst automatisch spiegelt.

Wichtige Projektentscheidung:
Die Menschen, die Instagram pflegen, sollen keine zweite Produktverwaltung lernen oder bedienen muessen. Vorerst ist Instagram die einzige gepflegte Quelle. Die Webseite soll Bilder, Beschreibungen, Links und erkennbare Statushinweise deshalb automatisch aus Instagram uebernehmen, soweit Instagram diese Daten oeffentlich ausliefert.

Preise bleiben auf der Webseite verborgen. Oeffentlich erscheint nur:

Price and availability on request

Das ist die optimale Zwischenloesung, bis es spaeter eventuell eine stabilere offizielle Instagram-API-Anbindung oder eine sehr einfache interne Pflegeoberflaeche gibt.

Aktueller Stand:
Der eigene Cloudflare-Instagram-Scraper wurde gebaut und deployed, aber Instagram blockiert die Abfrage mit HTTP 429. Deshalb nutzt die sichtbare Webseite jetzt SociableKIT als Feed-Dienst. SociableKIT akzeptierte `nunavutgallery` als oeffentliches Instagram-Profil und liefert echte Bilder und Captions.

Details stehen in PROJECT_NOTES.md.
