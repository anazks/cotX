// Team.js — Team hierarchy model for SourceHUB.
// Collection: teams
//
// Structure: each Team has ONE lead, N direct members, and optionally a parentTeam.
// This creates an unlimited-depth tree:
//
//   Team A (root, parentTeam: null)
//     lead: Ravi
//     members: [Priya, Suresh]
//     └── Team B (parentTeam: Team A)
//           lead: Priya
//           members: [Arun, Divya]
//           └── Team C (parentTeam: Team B)
//                 lead: Arun
//                 members: [Keerthi]
//
// Data visibility rules (enforced in quotationController + analyticsController):
//   individual  → own quotes only (createdBy = user._id)
//   team_lead   → own quotes + all quotes in their subtree (recursive downward)
//   isTenantAdmin → all quotes in tenant
//
// One tenant can have multiple root teams (multiple top-level leads).
// A user can only be in ONE team (enforced in teamController).

const mongoose = require('mongoose')

const teamSchema = new mongoose.Schema(
  {
    // ── Identity ─────────────────────────────────
    tenantId: {
      type:     String,
      required: true,
      trim:     true,
      index:    true,
    },

    // Optional display name — e.g. "North Region", "Sales Team A"
    // If not set, UI displays lead's name + "Team"
    name: {
      type:    String,
      trim:    true,
      default: '',
    },

    // ── Lead ─────────────────────────────────────
    // The team lead — has visibility over all members and sub-teams.
    // Required — a team must always have a lead.
    // When lead is changed, old lead's role reverts to 'individual'
    // unless they lead another team.
    leadId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },

    // ── Members ───────────────────────────────────
    // Direct members of this team (individuals, not sub-team leads).
    // Sub-team leads appear here as memberIds too — they report to this team's lead
    // but also have their own team below them.
    memberIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref:  'User',
      }
    ],

    // ── Hierarchy ────────────────────────────────
    // parentTeamId = null  → root team (this lead reports to nobody)
    // parentTeamId = ObjectId → this team's lead reports to that team's lead
    parentTeamId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Team',
      default: null,
    },
  },
  { timestamps: true }
)

// Compound index — fast lookup of all teams for a tenant
teamSchema.index({ tenantId: 1, leadId: 1 })

const Team = mongoose.model('Team', teamSchema)
module.exports = Team
