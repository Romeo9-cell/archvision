const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(cors());
app.use(express.json());

// ============================================================================
// SUPPLIER DATABASE (Replace with real data from your suppliers)
// ============================================================================

const SUPPLIER_RATES = {
  dar_es_salaam: {
    cement_per_bag: 18000, // TZS per 50kg bag
    steel_per_ton: 1800000, // TZS per ton (reinforcing)
    timber_per_cbm: 450000, // TZS per cubic meter (hardwood avg)
    sand_per_ton: 45000,
    gravel_per_ton: 50000,
    labor_per_day: 80000, // TZS per skilled laborer/day
    transport_markup: 1.05, // 5% transport cost
    import_markup: 1.15, // 15% if materials need importing
  },
  moshi_arusha: {
    cement_per_bag: 19000,
    steel_per_ton: 1900000,
    timber_per_cbm: 480000,
    sand_per_ton: 50000,
    gravel_per_ton: 55000,
    labor_per_day: 70000,
    transport_markup: 1.08,
    import_markup: 1.18,
  },
  zanzibar: {
    cement_per_bag: 22000, // Higher due to import
    steel_per_ton: 2100000,
    timber_per_cbm: 520000,
    sand_per_ton: 60000,
    gravel_per_ton: 65000,
    labor_per_day: 90000,
    transport_markup: 1.12,
    import_markup: 1.25,
  },
};

// ============================================================================
// CLAUDE PROMPT: Architectural Breakdown Analysis
// ============================================================================

const ARCHITECT_SYSTEM_PROMPT = `You are an expert construction cost estimator for East African architecture. 
Your job is to analyze a building project description and provide a detailed structural breakdown.

For the given project, you MUST respond in JSON format only with:
{
  "project_name": "string",
  "project_type": "residential|commercial|hospitality|industrial",
  "rooms": number,
  "estimated_area_sqm": number,
  "foundation": {
    "type": "strip_footing|raft|pile",
    "depth_meters": number,
    "concrete_volume_cbm": number,
    "steel_quantity_tons": number,
    "description": "string"
  },
  "columns": {
    "quantity": number,
    "size_mm": "400x400 or similar",
    "height_meters": number,
    "concrete_volume_cbm": number,
    "steel_quantity_tons": number,
    "description": "string"
  },
  "beams": {
    "quantity": number,
    "size_mm": "230x450 or similar",
    "length_total_meters": number,
    "concrete_volume_cbm": number,
    "steel_quantity_tons": number,
    "description": "string"
  },
  "floor_slab": {
    "area_sqm": number,
    "thickness_mm": 150,
    "concrete_volume_cbm": number,
    "steel_quantity_tons": number,
    "description": "string"
  },
  "walls": {
    "total_length_meters": number,
    "height_meters": number,
    "thickness_mm": 230,
    "brick_quantity_units": number,
    "mortar_volume_cbm": number,
    "description": "string"
  },
  "roof": {
    "type": "concrete|timber_truss|metal",
    "area_sqm": number,
    "materials_description": "string",
    "estimated_quantity": "string"
  },
  "finishes": {
    "flooring": "polished_concrete|tiles|timber",
    "walls": "paint|tiles|plaster",
    "paint_area_sqm": number,
    "tiles_sqm": number
  },
  "notes": "Any special considerations, imported materials, or structural notes"
}

Be realistic. For a "three room villa" assume:
- ~120-150 sqm total area
- Single story or 1.5 story
- Strip footings (common in Tanzania)
- Concrete slab floors
- Brick/block walls
- Concrete or timber roof
- Basic finishes

Adjust based on the description provided.`;

// ============================================================================
// CLAUDE API: Project Analysis
// ============================================================================

async function analyzeProjectWithClaude(projectDescription) {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Analyze this project and provide detailed structural breakdown: ${projectDescription}`,
        },
      ],
      system: ARCHITECT_SYSTEM_PROMPT,
    });

    const responseText = message.content[0].text;
    
    // Extract JSON from response (Claude might add text, extract the JSON block)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Claude did not return valid JSON');
    }

    const breakdown = JSON.parse(jsonMatch[0]);
    return breakdown;
  } catch (error) {
    console.error('Claude API error:', error);
    throw error;
  }
}

// ============================================================================
// COST CALCULATION ENGINE
// ============================================================================

function calculateCosts(breakdown, location, userInputs = {}) {
  const rates = SUPPLIER_RATES[location] || SUPPLIER_RATES.dar_es_salaam;

  // Use user inputs if provided (expert mode), otherwise use Claude's estimates
  const foundation = {
    concrete: (breakdown.foundation.concrete_volume_cbm * 350) * rates.cement_per_bag,
    steel: (breakdown.foundation.steel_quantity_tons * rates.steel_per_ton) * rates.transport_markup,
    labor: breakdown.foundation.depth_meters * breakdown.foundation.concrete_volume_cbm * 50000,
  };

  const columns = {
    concrete: (breakdown.columns.concrete_volume_cbm * 350) * rates.cement_per_bag,
    steel: (breakdown.columns.steel_quantity_tons * rates.steel_per_ton) * rates.transport_markup,
    labor: breakdown.columns.quantity * breakdown.columns.height_meters * 100000,
  };

  const beams = {
    concrete: (breakdown.beams.concrete_volume_cbm * 350) * rates.cement_per_bag,
    steel: (breakdown.beams.steel_quantity_tons * rates.steel_per_ton) * rates.transport_markup,
    labor: breakdown.beams.length_total_meters * 50000,
  };

  const floorSlab = {
    concrete: (breakdown.floor_slab.concrete_volume_cbm * 350) * rates.cement_per_bag,
    steel: (breakdown.floor_slab.steel_quantity_tons * rates.steel_per_ton) * rates.transport_markup,
    labor: breakdown.floor_slab.area_sqm * 5000,
  };

  const walls = {
    bricks: breakdown.walls.brick_quantity_units * 1500,
    mortar: (breakdown.walls.mortar_volume_cbm * 350) * rates.cement_per_bag,
    labor: breakdown.walls.total_length_meters * breakdown.walls.height_meters * 25000,
  };

  const roof = {
    materials: breakdown.roof.type === 'concrete' 
      ? (breakdown.roof.area_sqm * 350 * rates.cement_per_bag) 
      : (breakdown.roof.area_sqm * rates.timber_per_cbm / 2),
    labor: breakdown.roof.area_sqm * 75000,
  };

  const finishes = {
    paint: (breakdown.finishes.paint_area_sqm || 500) * 15000,
    tiles: (breakdown.finishes.tiles_sqm || 100) * 45000,
    doors_windows: breakdown.rooms * 8000000,
  };

  // Apply user inputs if expert mode
  if (userInputs.foundationCost) {
    foundation.total = userInputs.foundationCost;
  } else {
    foundation.total = foundation.concrete + foundation.steel + foundation.labor;
  }

  if (userInputs.structureCost) {
    const structure = userInputs.structureCost;
  } else {
    columns.total = columns.concrete + columns.steel + columns.labor;
    beams.total = beams.concrete + beams.steel + beams.labor;
    floorSlab.total = floorSlab.concrete + floorSlab.steel + floorSlab.labor;
  }

  walls.total = walls.bricks + walls.mortar + walls.labor;
  roof.total = roof.materials + roof.labor;
  finishes.total = finishes.paint + finishes.tiles + finishes.doors_windows;

  const substructure = foundation.total;
  const superstructure = (columns.total || 0) + (beams.total || 0) + (floorSlab.total || 0) + walls.total + roof.total;
  const finishesTotal = finishes.total;

  const subtotal = substructure + superstructure + finishesTotal;
  const contingency = subtotal * 0.1; // 10% contingency
  const total = subtotal + contingency;

  return {
    breakdown: {
      foundation: { ...breakdown.foundation, estimated_cost: foundation },
      columns: { ...breakdown.columns, estimated_cost: columns },
      beams: { ...breakdown.beams, estimated_cost: beams },
      floor_slab: { ...breakdown.floor_slab, estimated_cost: floorSlab },
      walls: { ...breakdown.walls, estimated_cost: walls },
      roof: { ...breakdown.roof, estimated_cost: roof },
      finishes: { ...breakdown.finishes, estimated_cost: finishes },
    },
    costs: {
      substructure,
      superstructure,
      finishes: finishesTotal,
      subtotal,
      contingency,
      total,
    },
    location,
    rates,
  };
}

// ============================================================================
// PDF GENERATION
// ============================================================================

function generateEstimatePDF(data, filename) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ bufferPages: true });
      const stream = fs.createWriteStream(filename);

      doc.pipe(stream);

      // Header
      doc.fontSize(28).font('Helvetica-Bold').text('ArchVision', 50, 40);
      doc.fontSize(11).font('Helvetica').text('Construction Cost Estimator', 50, 75);
      doc.moveTo(50, 95).lineTo(550, 95).stroke();

      // Project info
      doc.fontSize(14).font('Helvetica-Bold').text('Project Estimate', 50, 120);
      doc.fontSize(11).font('Helvetica').text(`Project: ${data.breakdown.project_name}`, 50, 145);
      doc.text(`Type: ${data.breakdown.project_type}`, 50, 165);
      doc.text(`Location: ${data.location.replace('_', ' ').toUpperCase()}`, 50, 185);
      doc.text(`Date: ${new Date().toLocaleDateString()}`, 50, 205);

      // Cost summary
      doc.fontSize(12).font('Helvetica-Bold').text('Cost Summary', 50, 240);
      doc.fontSize(10).font('Helvetica');

      const costTableY = 265;
      const rows = [
        ['Substructure (Foundation, columns, beams)', `TZS ${data.costs.substructure.toLocaleString()}`],
        ['Superstructure (Walls, floors, roof)', `TZS ${data.costs.superstructure.toLocaleString()}`],
        ['Finishes (Paint, tiles, doors, windows)', `TZS ${data.costs.finishes.toLocaleString()}`],
        ['Subtotal', `TZS ${data.costs.subtotal.toLocaleString()}`],
        ['Contingency (10%)', `TZS ${data.costs.contingency.toLocaleString()}`],
      ];

      rows.forEach((row, i) => {
        const y = costTableY + i * 20;
        doc.text(row[0], 50, y, { width: 350 });
        doc.text(row[1], 400, y, { align: 'right' });
      });

      // Total
      doc.fontSize(12).font('Helvetica-Bold');
      doc.moveTo(50, costTableY + rows.length * 20).lineTo(550, costTableY + rows.length * 20).stroke();
      doc.text('TOTAL PROJECT COST', 50, costTableY + rows.length * 20 + 10);
      doc.fontSize(16).text(`TZS ${data.costs.total.toLocaleString()}`, 400, costTableY + rows.length * 20 + 10, { align: 'right' });

      // Structural details
      doc.fontSize(12).font('Helvetica-Bold').text('Structural Breakdown', 50, costTableY + rows.length * 20 + 60);
      doc.fontSize(9).font('Helvetica');

      const detailsY = costTableY + rows.length * 20 + 85;
      let currentY = detailsY;

      Object.entries(data.breakdown).forEach(([key, value]) => {
        if (typeof value === 'object' && value.description) {
          doc.text(`${key.toUpperCase()}: ${value.description}`, 50, currentY, { width: 500 });
          currentY += 30;
        }
      });

      // Footer
      doc.fontSize(8).text('This estimate is based on standard construction practices in Tanzania. Local material costs and labor rates may vary. Architect consultation recommended before project commencement.', 50, doc.page.height - 50, { width: 500 });

      doc.end();

      stream.on('finish', () => {
        resolve(filename);
      });

      stream.on('error', reject);
    } catch (error) {
      reject(error);
    }
  });
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Estimate endpoint
app.post('/api/estimate', async (req, res) => {
  try {
    const { projectDescription, location, mode, userInputs } = req.body;

    if (!projectDescription || !location) {
      return res.status(400).json({ error: 'Project description and location required' });
    }

    // Step 1: Analyze with Claude
    const breakdown = await analyzeProjectWithClaude(projectDescription);

    // Step 2: Calculate costs based on location and mode
    const estimate = calculateCosts(breakdown, location, userInputs || {});

    // Step 3: Generate PDF
    const pdfFilename = `estimate_${Date.now()}.pdf`;
    const pdfPath = path.join(__dirname, 'pdfs', pdfFilename);
    
    // Ensure pdfs directory exists
    if (!fs.existsSync(path.join(__dirname, 'pdfs'))) {
      fs.mkdirSync(path.join(__dirname, 'pdfs'), { recursive: true });
    }

    await generateEstimatePDF(estimate, pdfPath);

    // Return JSON response + PDF URL
    res.json({
      success: true,
      estimate: {
        project: breakdown,
        costs: estimate.costs,
        breakdown: estimate.breakdown,
      },
      pdfUrl: `/pdfs/${pdfFilename}`,
    });
  } catch (error) {
    console.error('Estimate error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve PDFs
app.use('/pdfs', express.static('pdfs'));

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`ArchVision backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
