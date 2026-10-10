/**
 * Hotel configuration — edit this file to adapt the app to another hotel.
 * Texts are keyed by language code (es, en, fr, de).
 * Source of the data below: delunahotels.com (Gran Hotel Luna de Granada), 2026-09.
 */
export const HOTEL = {
  id: 'gran-hotel-luna-granada',
  name: 'Gran Hotel Luna de Granada',
  brand: 'De Luna Hotels',
  address: 'Plaza del Guitarrista Manuel Cano, 2 · 18004 Granada',
  phone: '+34 958 28 29 13',
  email: 'reservaslunagranada@delunahotels.com',
  // Plaza del Guitarrista Manuel Cano 2 (esquina Arabial) — 1,2 km de la Catedral.
  lat: 37.17654,
  lon: -3.612782,
  // Camera used for the welcome view (metres above ground, degrees).
  welcomeView: { height: 900, heading: 35, pitch: -38 },
  wifi: {
    note: {
      es: 'Wi-Fi gratuito en todo el hotel',
      en: 'Free Wi-Fi throughout the hotel',
      fr: 'Wi-Fi gratuit dans tout l’hôtel',
      de: 'Kostenloses WLAN im gesamten Hotel',
    },
  },
  reception: {
    es: 'Recepción 24 h · marque 9 desde su habitación',
    en: 'Reception 24 h · dial 9 from your room',
    fr: 'Réception 24 h · composez le 9 depuis votre chambre',
    de: 'Rezeption 24 h · wählen Sie die 9 von Ihrem Zimmer',
  },
};

/**
 * Services and activities inside the hotel.
 * `hours` is free text per language; `open` is an optional weekly schedule used
 * to show "open now" — days 0..6 (Sunday=0), times "HH:MM".
 */
export const HOTEL_SERVICES = [
  {
    id: 'breakfast',
    icon: 'restaurant',
    category: 'food',
    name: {
      es: 'Desayuno 24 horas',
      en: '24-hour breakfast',
      fr: 'Petit-déjeuner 24 h',
      de: 'Frühstück rund um die Uhr',
    },
    desc: {
      es: 'Nuevo y exclusivo: desayune a la hora que quiera, cualquier día.',
      en: 'New & exclusive: breakfast whenever you like, any day.',
      fr: 'Nouveau et exclusif : petit-déjeuner à toute heure.',
      de: 'Neu & exklusiv: Frühstück wann immer Sie möchten.',
    },
    hours: {
      es: 'Siempre abierto',
      en: 'Always open',
      fr: 'Toujours ouvert',
      de: 'Immer geöffnet',
    },
    open: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' }],
  },
  {
    id: 'gastrobar',
    icon: 'local_bar',
    category: 'food',
    name: {
      es: 'Gastrobar',
      en: 'Gastrobar',
      fr: 'Gastrobar',
      de: 'Gastrobar',
    },
    desc: {
      es: 'Tapas y cocina andaluza en la planta baja.',
      en: 'Tapas and Andalusian cooking on the ground floor.',
      fr: 'Tapas et cuisine andalouse au rez-de-chaussée.',
      de: 'Tapas und andalusische Küche im Erdgeschoss.',
    },
    hours: {
      es: 'Consulte horario en recepción',
      en: 'Ask reception for hours',
      fr: 'Horaires à la réception',
      de: 'Öffnungszeiten an der Rezeption',
    },
  },
  {
    id: 'snackbar',
    icon: 'wb_sunny',
    category: 'food',
    name: {
      es: 'Snack bar exterior y solárium',
      en: 'Outdoor snack bar & solarium',
      fr: 'Snack-bar extérieur et solarium',
      de: 'Snackbar im Freien & Solarium',
    },
    desc: {
      es: 'Cócteles y picoteo junto a la piscina exterior (temporada).',
      en: 'Cocktails and snacks by the outdoor pool (seasonal).',
      fr: 'Cocktails et en-cas près de la piscine extérieure (saisonnier).',
      de: 'Cocktails und Snacks am Außenpool (saisonal).',
    },
    hours: {
      es: '18:00 – 00:00 (temporada)',
      en: '6 PM – midnight (seasonal)',
      fr: '18h – 00h (saison)',
      de: '18–24 Uhr (saisonal)',
    },
    open: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '18:00', to: '23:59' }],
  },
  {
    id: 'indoor-pool',
    icon: 'pool',
    category: 'wellness',
    name: {
      es: 'Piscina interior climatizada',
      en: 'Heated indoor pool',
      fr: 'Piscine intérieure chauffée',
      de: 'Beheiztes Hallenbad',
    },
    desc: {
      es: 'Abierta todo el año.',
      en: 'Open all year round.',
      fr: 'Ouverte toute l’année.',
      de: 'Ganzjährig geöffnet.',
    },
    hours: {
      es: '10:00 – 22:00',
      en: '10 AM – 10 PM',
      fr: '10h – 22h',
      de: '10–22 Uhr',
    },
    open: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '10:00', to: '22:00' }],
  },
  {
    id: 'outdoor-pool',
    icon: 'pool',
    category: 'wellness',
    name: {
      es: 'Piscina exterior',
      en: 'Outdoor pool',
      fr: 'Piscine extérieure',
      de: 'Außenpool',
    },
    desc: {
      es: 'Para adultos y niños, en temporada de verano.',
      en: 'For adults and children, summer season.',
      fr: 'Adultes et enfants, en été.',
      de: 'Für Erwachsene und Kinder, in der Sommersaison.',
    },
    hours: {
      es: 'Temporada de verano',
      en: 'Summer season',
      fr: 'Saison estivale',
      de: 'Sommersaison',
    },
  },
  {
    id: 'spa',
    icon: 'spa',
    category: 'wellness',
    name: {
      es: 'Spa y masajes',
      en: 'Spa & massages',
      fr: 'Spa et massages',
      de: 'Spa & Massagen',
    },
    desc: {
      es: 'Zona wellness con cabinas de masaje y tratamientos de belleza. Reserve en recepción.',
      en: 'Wellness area with massage rooms and beauty treatments. Book at reception.',
      fr: 'Espace bien-être avec cabines de massage et soins beauté. Réservez à la réception.',
      de: 'Wellnessbereich mit Massagekabinen und Beauty-Anwendungen. Buchung an der Rezeption.',
    },
    hours: {
      es: 'Con cita previa',
      en: 'By appointment',
      fr: 'Sur rendez-vous',
      de: 'Nach Vereinbarung',
    },
    bookable: true,
  },
  {
    id: 'gym',
    icon: 'fitness_center',
    category: 'wellness',
    name: {
      es: 'Gimnasio',
      en: 'Gym',
      fr: 'Salle de sport',
      de: 'Fitnessraum',
    },
    desc: {
      es: 'Máquinas de cardio y musculación de última generación.',
      en: 'State-of-the-art cardio and weight machines.',
      fr: 'Appareils de cardio et de musculation dernière génération.',
      de: 'Moderne Cardio- und Kraftgeräte.',
    },
    hours: {
      es: 'Consulte horario en recepción',
      en: 'Ask reception for hours',
      fr: 'Horaires à la réception',
      de: 'Öffnungszeiten an der Rezeption',
    },
  },
  {
    id: 'kids',
    icon: 'child_care',
    category: 'family',
    name: {
      es: 'Zona infantil',
      en: 'Children’s play area',
      fr: 'Espace enfants',
      de: 'Kinderspielbereich',
    },
    desc: {
      es: 'Espacio de juegos supervisado.',
      en: 'Supervised play area.',
      fr: 'Aire de jeux surveillée.',
      de: 'Beaufsichtigter Spielbereich.',
    },
    hours: {
      es: 'Vie, sáb y vísperas de festivo 17:00 – 23:00',
      en: 'Fri, Sat & holiday eves 5 PM – 11 PM',
      fr: 'Ven., sam. et veilles de fête 17h – 23h',
      de: 'Fr, Sa & vor Feiertagen 17–23 Uhr',
    },
    open: [{ days: [5, 6], from: '17:00', to: '23:00' }],
  },
  {
    id: 'lounge',
    icon: 'menu_book',
    category: 'leisure',
    name: {
      es: 'Sala de lectura y TV',
      en: 'Reading room & TV lounge',
      fr: 'Salle de lecture et TV',
      de: 'Lesezimmer & TV-Lounge',
    },
    desc: {
      es: 'Un rincón tranquilo para leer o ver la tele.',
      en: 'A quiet corner to read or watch TV.',
      fr: 'Un coin tranquille pour lire ou regarder la télé.',
      de: 'Eine ruhige Ecke zum Lesen oder Fernsehen.',
    },
    hours: {
      es: 'Siempre abierta',
      en: 'Always open',
      fr: 'Toujours ouverte',
      de: 'Immer geöffnet',
    },
  },
  {
    id: 'business',
    icon: 'business_center',
    category: 'business',
    name: {
      es: 'Business area y salones',
      en: 'Business area & meeting rooms',
      fr: 'Espace affaires et salons',
      de: 'Business-Bereich & Tagungsräume',
    },
    desc: {
      es: 'Zona de trabajo y salones para eventos.',
      en: 'Work area and function rooms for events.',
      fr: 'Espace de travail et salons pour événements.',
      de: 'Arbeitsbereich und Veranstaltungsräume.',
    },
    hours: {
      es: 'Consulte en recepción',
      en: 'Ask at reception',
      fr: 'Renseignements à la réception',
      de: 'Info an der Rezeption',
    },
  },
  {
    id: 'parking',
    icon: 'local_parking',
    category: 'practical',
    name: { es: 'Parking', en: 'Parking', fr: 'Parking', de: 'Parkplatz' },
    desc: {
      es: 'Plaza garantizada. 18,95 €/noche (1–2 noches), 15,95 €/noche (3+ noches). Puntos de carga para coche eléctrico.',
      en: 'Guaranteed space. €18.95/night (1–2 nights), €15.95/night (3+ nights). EV charging points.',
      fr: 'Place garantie. 18,95 €/nuit (1–2 nuits), 15,95 €/nuit (3+ nuits). Bornes de recharge.',
      de: 'Garantierter Platz. 18,95 €/Nacht (1–2 Nächte), 15,95 €/Nacht (ab 3). E-Ladepunkte.',
    },
    hours: { es: '24 h', en: '24 h', fr: '24 h', de: '24 h' },
  },
  {
    id: 'pets',
    icon: 'pets',
    category: 'practical',
    name: {
      es: 'Mascotas bienvenidas',
      en: 'Pets welcome',
      fr: 'Animaux bienvenus',
      de: 'Haustiere willkommen',
    },
    desc: {
      es: 'Perros y gatos hasta 30 kg.',
      en: 'Dogs and cats up to 30 kg.',
      fr: 'Chiens et chats jusqu’à 30 kg.',
      de: 'Hunde und Katzen bis 30 kg.',
    },
    hours: { es: '', en: '', fr: '', de: '' },
  },
];

/**
 * Quick actions the guest can trigger from the Tasks panel. `tel` dials a
 * number; `mail` opens an email; `url` opens a page. Reception handles the
 * request when no dedicated channel exists.
 */
export const HOTEL_ACTIONS = [
  {
    id: 'spa',
    icon: 'spa',
    fields: ['when', 'people', 'details'],
    name: {
      es: 'Reservar spa / masaje',
      en: 'Book spa / massage',
      fr: 'Réserver spa / massage',
      de: 'Spa / Massage buchen',
    },
  },
  {
    id: 'table',
    icon: 'restaurant',
    fields: ['when', 'people', 'details'],
    name: {
      es: 'Reservar mesa en el gastrobar',
      en: 'Book a table at the gastrobar',
      fr: 'Réserver une table au gastrobar',
      de: 'Tisch im Gastrobar reservieren',
    },
  },
  {
    id: 'breakfast',
    icon: 'egg_alt',
    fields: ['when', 'people', 'details'],
    name: {
      es: 'Desayuno en la habitación',
      en: 'Breakfast in your room',
      fr: 'Petit-déjeuner en chambre',
      de: 'Frühstück aufs Zimmer',
    },
  },
  {
    id: 'taxi',
    icon: 'local_taxi',
    fields: ['when', 'destination', 'people'],
    tel: '+34 958 28 06 54',
    sub: {
      es: 'Radio Taxi Granada',
      en: 'Radio Taxi Granada',
      fr: 'Radio Taxi Granada',
      de: 'Radio Taxi Granada',
    },
    name: {
      es: 'Pedir un taxi',
      en: 'Call a taxi',
      fr: 'Appeler un taxi',
      de: 'Taxi rufen',
    },
  },
  {
    id: 'latecheckout',
    icon: 'schedule',
    fields: ['when', 'details'],
    name: {
      es: 'Pedir late check-out',
      en: 'Request late check-out',
      fr: 'Demander un départ tardif',
      de: 'Late Check-out anfragen',
    },
  },
  {
    id: 'housekeeping',
    icon: 'cleaning_services',
    fields: ['details'],
    name: {
      es: 'Toallas / limpieza',
      en: 'Towels / housekeeping',
      fr: 'Serviettes / ménage',
      de: 'Handtücher / Zimmerservice',
    },
  },
  {
    id: 'parking',
    icon: 'local_parking',
    fields: ['when', 'details'],
    name: {
      es: 'Plaza de parking',
      en: 'Parking space',
      fr: 'Place de parking',
      de: 'Parkplatz',
    },
  },
  {
    id: 'flamenco',
    icon: 'music_note',
    fields: ['when', 'people', 'details'],
    name: {
      es: 'Reservar espectáculo flamenco',
      en: 'Book a flamenco show',
      fr: 'Réserver un spectacle de flamenco',
      de: 'Flamenco-Show buchen',
    },
  },
  {
    id: 'reception',
    icon: 'support_agent',
    tel: HOTEL.phone,
    name: {
      es: 'Hablar con recepción',
      en: 'Talk to reception',
      fr: 'Parler à la réception',
      de: 'Mit der Rezeption sprechen',
    },
  },
];
