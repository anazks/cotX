// teamController.js — Team hierarchy management for SourceHUB.
//
// Used by:
//   Tenant Admin → Team Manager page (/quotex/team)
//   Super Admin  → AdminTenantDetail (replaceUser, setTenantAdmin)
//
// ── Endpoints ────────────────────────────────────────────────────
//   GET    /api/quotex/teams                → getTeams (all teams for tenant)
//   POST   /api/quotex/teams                → createTeam
//   PUT    /api/quotex/teams/:id            → updateTeam (rename, change lead, members)
//   DELETE /api/quotex/teams/:id            → deleteTeam
//   GET    /api/quotex/teams/members        → getTenantUsers (all users for org chart)
//   GET    /api/quotex/teams/subtree/:userId → getSubtreeUserIds (for filters)
//
// Super admin only:
//   PATCH  /api/admin/users/:id/set-admin   → setTenantAdmin
//   POST   /api/admin/users/:id/replace     → replaceUser

const Team      = require('../models/Team')
const User      = require('../models/User')
const Quotation = require('../models/Quotation')

// ══════════════════════════════════════════════════════════════
// SHARED UTILITY — Resolve full subtree of user IDs under a lead
// ══════════════════════════════════════════════════════════════
// Given a leadId, returns all user _ids in their entire downward subtree.
// Includes the lead themselves + all members + all sub-leads + their members etc.
// Used by quotationController and analyticsController to scope queries.
//
// Algorithm: BFS (breadth-first) through Team tree.
// Each iteration finds all teams led by users collected in the previous pass.
// Stops when no new teams are found (leaf level reached).
//
// Returns: Set of ObjectId strings (use .has() for O(1) lookup)

const getSubtreeUserIds = async (leadId, tenantId) => {
  // Clean BFS through the team tree.
  // visited tracks which leadIds we have already queried teams for.
  // allUserIds is the growing set of every user in the subtree.
  const allUserIds = new Set()
  const visited    = new Set()

  // Start with the lead themselves
  const rootStr = leadId.toString()
  allUserIds.add(rootStr)

  // Queue holds string IDs of users whose teams we still need to fetch
  let queue = [rootStr]

  while (queue.length > 0) {
    // Avoid re-querying the same user twice
    const toFetch = queue.filter(id => !visited.has(id))
    if (toFetch.length === 0) break

    toFetch.forEach(id => visited.add(id))

    // Find all teams where leadId is one of the users we're exploring
    const teams = await Team.find({
      tenantId,
      leadId: { $in: toFetch },
    }).select('memberIds').lean()

    queue = []

    for (const team of teams) {
      for (const memberId of (team.memberIds || [])) {
        const mStr = memberId.toString()
        if (!allUserIds.has(mStr)) {
          allUserIds.add(mStr)
          // This member might also be a lead — explore their sub-teams too
          queue.push(mStr)
        }
      }
    }
  }

  return allUserIds
}

// Export for use in quotationController and analyticsController
module.exports.getSubtreeUserIds = getSubtreeUserIds

// ══════════════════════════════════════════════════════════════
// ENDPOINT 1 — Get all teams for the tenant
// GET /api/quotex/teams
// Returns full team tree with populated lead and member names.
// Used to render the org chart.
// ══════════════════════════════════════════════════════════════
const getTeams = async (req, res) => {
  try {
    const tenantId = req.user.tenantId

    const teams = await Team.find({ tenantId })
      .populate('leadId',   'firstName lastName email role isTenantAdmin')
      .populate('memberIds','firstName lastName email role')
      .lean()

    res.status(200).json({ teams })
  } catch (err) {
    console.error('getTeams error:', err)
    res.status(500).json({ message: 'Failed to fetch teams', error: err.message })
  }
}

// ══════════════════════════════════════════════════════════════
// ENDPOINT 2 — Get all users in the tenant (for org chart dropdown)
// GET /api/quotex/teams/members
// Returns all non-super_admin users in the tenant with their current team assignment.
// ══════════════════════════════════════════════════════════════
const getTenantUsers = async (req, res) => {
  try {
    const tenantId = req.user.tenantId

    const users = await User.find({
      tenantId,
      role: { $ne: 'super_admin' },
    })
    .select('firstName lastName email role isTenantAdmin isActive')
    .lean()

    // Attach team info to each user
    const allTeams = await Team.find({ tenantId }).lean()
    const userTeamMap = {}

    allTeams.forEach(team => {
      // Mark lead
      const leadStr = team.leadId.toString()
      if (!userTeamMap[leadStr]) userTeamMap[leadStr] = []
      userTeamMap[leadStr].push({ teamId: team._id, teamName: team.name, role: 'lead' })

      // Mark members
      team.memberIds.forEach(mId => {
        const mStr = mId.toString()
        if (!userTeamMap[mStr]) userTeamMap[mStr] = []
        userTeamMap[mStr].push({ teamId: team._id, teamName: team.name, role: 'member' })
      })
    })

    const usersWithTeams = users.map(u => ({
      ...u,
      teams: userTeamMap[u._id.toString()] || [],
    }))

    res.status(200).json({ users: usersWithTeams })
  } catch (err) {
    console.error('getTenantUsers error:', err)
    res.status(500).json({ message: 'Failed to fetch users', error: err.message })
  }
}

// ══════════════════════════════════════════════════════════════
// ENDPOINT 3 — Create a new team
// POST /api/quotex/teams
// Body: { leadId, memberIds[], name?, parentTeamId? }
// ══════════════════════════════════════════════════════════════
const createTeam = async (req, res) => {
  try {
    const tenantId = req.user.tenantId
    const { leadId, memberIds = [], name, parentTeamId } = req.body

    if (!leadId) return res.status(400).json({ message: 'leadId is required' })

    // Validate lead belongs to this tenant
    const lead = await User.findOne({ _id: leadId, tenantId })
    if (!lead) return res.status(404).json({ message: 'Lead user not found in this tenant' })

    // Validate members belong to this tenant
    if (memberIds.length > 0) {
      const memberCount = await User.countDocuments({
        _id: { $in: memberIds }, tenantId,
      })
      if (memberCount !== memberIds.length) {
        return res.status(400).json({ message: 'One or more members not found in this tenant' })
      }
    }

    // A user can only be lead of one team at a time
    const existingLeadTeam = await Team.findOne({ tenantId, leadId })
    if (existingLeadTeam) {
      return res.status(409).json({
        message: `${lead.firstName} ${lead.lastName} is already a lead of another team. Remove them first.`,
      })
    }

    // A user can only be a member of one team at a time
    // Check none of the requested members already belong to another team
    if (memberIds.length > 0) {
      const conflictTeam = await Team.findOne({
        tenantId,
        memberIds: { $in: memberIds },
      }).populate('leadId', 'firstName lastName')

      if (conflictTeam) {
        // Find which specific member caused the conflict
        const conflictMemberIds = memberIds.filter(mId =>
          conflictTeam.memberIds.some(existing => existing.toString() === mId.toString())
        )
        const conflictUsers = await User.find({
          _id: { $in: conflictMemberIds },
        }).select('firstName lastName').lean()

        const names = conflictUsers.map(u => `${u.firstName} ${u.lastName}`).join(', ')
        const teamName = conflictTeam.name || `${conflictTeam.leadId?.firstName}'s Team`
        return res.status(409).json({
          message: `${names} is already a member of "${teamName}". A user can only belong to one team.`,
        })
      }
    }

    const team = await Team.create({
      tenantId,
      leadId,
      memberIds,
      name:         name || '',
      parentTeamId: parentTeamId || null,
    })

    // Update lead's role to team_lead
    await User.findByIdAndUpdate(leadId, { $set: { role: 'team_lead' } })

    const populated = await Team.findById(team._id)
      .populate('leadId',   'firstName lastName email role')
      .populate('memberIds','firstName lastName email role')

    res.status(201).json({ message: 'Team created successfully', team: populated })
  } catch (err) {
    console.error('createTeam error:', err)
    res.status(500).json({ message: 'Failed to create team', error: err.message })
  }
}

// ══════════════════════════════════════════════════════════════
// ENDPOINT 4 — Update a team
// PUT /api/quotex/teams/:id
// Body: { leadId?, memberIds?, name?, parentTeamId? }
// Handles: rename, change lead, add/remove members, reparent
// ══════════════════════════════════════════════════════════════
const updateTeam = async (req, res) => {
  try {
    const tenantId = req.user.tenantId
    const team = await Team.findOne({ _id: req.params.id, tenantId })
    if (!team) return res.status(404).json({ message: 'Team not found' })

    const { leadId, memberIds, name, parentTeamId } = req.body

    // ── Handle lead change ────────────────────────
    if (leadId && leadId.toString() !== team.leadId.toString()) {
      // Validate new lead
      const newLead = await User.findOne({ _id: leadId, tenantId })
      if (!newLead) return res.status(404).json({ message: 'New lead not found' })

      // New lead must not already be leading another team
      const alreadyLeads = await Team.findOne({
        tenantId, leadId, _id: { $ne: team._id },
      })
      if (alreadyLeads) {
        return res.status(409).json({
          message: `${newLead.firstName} ${newLead.lastName} already leads another team.`,
        })
      }

      // Revert old lead's role to individual (if they don't lead any other team)
      const oldLeadOtherTeams = await Team.countDocuments({
        tenantId,
        leadId: team.leadId,
        _id: { $ne: team._id },
      })
      if (oldLeadOtherTeams === 0) {
        await User.findByIdAndUpdate(team.leadId, { $set: { role: 'individual' } })
      }

      // Set new lead role
      await User.findByIdAndUpdate(leadId, { $set: { role: 'team_lead' } })
      team.leadId = leadId
    }

    if (memberIds !== undefined) {
      // Check none of the new members already belong to a DIFFERENT team
      if (memberIds.length > 0) {
        const conflictTeam = await Team.findOne({
          tenantId,
          _id: { $ne: team._id },          // exclude current team
          memberIds: { $in: memberIds },
        }).populate('leadId', 'firstName lastName')

        if (conflictTeam) {
          const conflictMemberIds = memberIds.filter(mId =>
            conflictTeam.memberIds.some(existing => existing.toString() === mId.toString())
          )
          const conflictUsers = await User.find({
            _id: { $in: conflictMemberIds },
          }).select('firstName lastName').lean()

          const names = conflictUsers.map(u => `${u.firstName} ${u.lastName}`).join(', ')
          const teamName = conflictTeam.name || `${conflictTeam.leadId?.firstName}'s Team`
          return res.status(409).json({
            message: `${names} is already a member of "${teamName}". Remove them from that team first.`,
          })
        }
      }
      team.memberIds = memberIds
    }
    if (name      !== undefined) team.name         = name
    if (parentTeamId !== undefined) team.parentTeamId = parentTeamId || null

    await team.save()

    const populated = await Team.findById(team._id)
      .populate('leadId',   'firstName lastName email role')
      .populate('memberIds','firstName lastName email role')

    res.status(200).json({ message: 'Team updated successfully', team: populated })
  } catch (err) {
    console.error('updateTeam error:', err)
    res.status(500).json({ message: 'Failed to update team', error: err.message })
  }
}

// ══════════════════════════════════════════════════════════════
// ENDPOINT 5 — Delete a team
// DELETE /api/quotex/teams/:id
// Sub-teams are re-parented to the deleted team's parent.
// Members become unassigned individuals.
// ══════════════════════════════════════════════════════════════
const deleteTeam = async (req, res) => {
  try {
    const tenantId = req.user.tenantId
    const team = await Team.findOne({ _id: req.params.id, tenantId })
    if (!team) return res.status(404).json({ message: 'Team not found' })

    // Re-parent child teams to this team's parent
    await Team.updateMany(
      { tenantId, parentTeamId: team._id },
      { $set: { parentTeamId: team.parentTeamId || null } }
    )

    // Revert lead's role to individual if they don't lead other teams
    const otherTeams = await Team.countDocuments({
      tenantId, leadId: team.leadId, _id: { $ne: team._id },
    })
    if (otherTeams === 0) {
      await User.findByIdAndUpdate(team.leadId, { $set: { role: 'individual' } })
    }

    await Team.findByIdAndDelete(team._id)
    res.status(200).json({ message: 'Team deleted. Members are now unassigned.' })
  } catch (err) {
    console.error('deleteTeam error:', err)
    res.status(500).json({ message: 'Failed to delete team', error: err.message })
  }
}

// ══════════════════════════════════════════════════════════════
// ENDPOINT 6 — Get subtree user IDs (for dashboard/tracker filters)
// GET /api/quotex/teams/subtree/:userId
// Returns flat array of user IDs in the subtree of the given lead.
// Used by frontend to populate the "member filter" dropdown.
// ══════════════════════════════════════════════════════════════
const getSubtreeEndpoint = async (req, res) => {
  try {
    const tenantId = req.user.tenantId
    const targetId = req.params.userId || req.user._id

    const subtree = await getSubtreeUserIds(targetId, tenantId)
    const userIds = [...subtree]

    // Fetch names for the frontend dropdown
    const users = await User.find({
      _id: { $in: userIds },
    }).select('firstName lastName email').lean()

    res.status(200).json({ userIds, users })
  } catch (err) {
    console.error('getSubtree error:', err)
    res.status(500).json({ message: 'Failed to resolve subtree', error: err.message })
  }
}

module.exports = {
  getTeams,
  getTenantUsers,
  createTeam,
  updateTeam,
  deleteTeam,
  getSubtreeEndpoint,
  getSubtreeUserIds,   // exported for use in quotationController + analyticsController
}
