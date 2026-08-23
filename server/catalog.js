export const formats = Object.freeze([
  {
    id: "fmt_travel",
    slug: "travel-sleeve",
    sku: "SR-T01",
    name: "Travel Sleeve",
    count: 1,
    status: "prelaunch",
    interestOpen: true,
    featured: false,
    structure: "Slim paper sleeve",
    primaryUse: "Trial and travel",
    dimensions: { lengthMm: 190, widthMm: 38, depthMm: 22 },
    description: "One sealed 165 mm chewing stick in a narrow kraft cradle and tamper-evident forest-green sleeve, designed for trial, hospitality, travel, and sampling.",
    included: ["One wrapped botanical chewing stick", "Quick ritual guide"],
    pricing: null
  },
  {
    id: "fmt_ritual",
    slug: "daily-ritual",
    sku: "SR-R05",
    name: "Daily Ritual",
    count: 5,
    status: "prelaunch",
    interestOpen: true,
    featured: true,
    structure: "Pull-drawer carton",
    primaryUse: "Daily ritual",
    dimensions: { lengthMm: 200, widthMm: 110, depthMm: 38 },
    description: "Five individually wrapped chewing sticks in a pull-drawer carton, paired with a reusable ventilated travel tube and a folded ritual-and-care guide.",
    included: ["Five wrapped botanical chewing sticks", "Reusable ventilated travel tube", "Ritual and care guide"],
    pricing: null
  },
  {
    id: "fmt_family",
    slug: "family-reserve",
    sku: "SR-F12",
    name: "Family Reserve",
    count: 12,
    status: "prelaunch",
    interestOpen: true,
    featured: false,
    structure: "Recloseable paperboard box",
    primaryUse: "Household reserve",
    dimensions: { lengthMm: 210, widthMm: 155, depthMm: 50 },
    description: "Twelve individually wrapped chewing sticks in two indexed rows, protected by a fibre organizer and recloseable paperboard carton for households and repeat use.",
    included: ["Twelve wrapped botanical chewing sticks", "Recloseable paper band", "Ritual and care guide"],
    pricing: null
  }
]);

export const formatBySlug = new Map(formats.map((format) => [format.slug, format]));
export const formatSlugByName = new Map(formats.map((format) => [format.name.toLowerCase(), format.slug]));
