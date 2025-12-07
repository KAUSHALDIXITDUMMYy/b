/**
 * User Manager - Handles multi-user account management
 * 
 * Data Structure:
 * - users: { username: { displayName, role, createdAt, isActive } }
 * - profiles: { profileName: { ...profileSettings } }  
 * - assignments: { username: { profiles: [profileName], mainProfile: profileName } }
 */

const fs = require('fs');
const path = require('path');

class UserManager {
  constructor() {
    this.dataPath = path.join(__dirname, 'data', 'users.json');
    this.data = this.load();
  }

  // =============================================
  // DATA PERSISTENCE
  // =============================================

  load() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error('Error loading user data:', e.message);
    }
    
    // Default data structure
    return {
      users: {
        admin: {
          displayName: 'Administrator',
          role: 'admin',
          createdAt: new Date().toISOString(),
          isActive: true
        }
      },
      profiles: {},
      assignments: {}
    };
  }

  save() {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
      return true;
    } catch (e) {
      console.error('Error saving user data:', e.message);
      return false;
    }
  }

  // =============================================
  // USER MANAGEMENT
  // =============================================

  getAllUsers() {
    return Object.entries(this.data.users).map(([username, data]) => ({
      username,
      ...data,
      assignedProfiles: this.getUserProfiles(username),
      mainProfile: this.getUserMainProfile(username)
    }));
  }

  getUser(username) {
    const user = this.data.users[username];
    if (!user) return null;
    
    return {
      username,
      ...user,
      assignedProfiles: this.getUserProfiles(username),
      mainProfile: this.getUserMainProfile(username)
    };
  }

  createUser(username, displayName = null, role = 'user') {
    if (this.data.users[username]) {
      return { success: false, error: 'User already exists' };
    }

    // Sanitize username (URL-safe)
    const sanitized = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (sanitized !== username) {
      return { success: false, error: 'Username must be lowercase alphanumeric with - or _' };
    }

    this.data.users[username] = {
      displayName: displayName || username,
      role: role,
      createdAt: new Date().toISOString(),
      isActive: true
    };

    this.data.assignments[username] = {
      profiles: [],
      mainProfile: null
    };

    this.save();
    return { success: true, user: this.getUser(username) };
  }

  updateUser(username, updates) {
    if (!this.data.users[username]) {
      return { success: false, error: 'User not found' };
    }

    Object.assign(this.data.users[username], updates);
    this.save();
    return { success: true, user: this.getUser(username) };
  }

  deleteUser(username) {
    if (!this.data.users[username]) {
      return { success: false, error: 'User not found' };
    }

    if (username === 'admin') {
      return { success: false, error: 'Cannot delete admin user' };
    }

    delete this.data.users[username];
    delete this.data.assignments[username];
    this.save();
    return { success: true };
  }

  isAdmin(username) {
    const user = this.data.users[username];
    return user && user.role === 'admin';
  }

  userExists(username) {
    return !!this.data.users[username];
  }

  isUserActive(username) {
    const user = this.data.users[username];
    return user && user.isActive !== false;
  }

  // =============================================
  // PROFILE MANAGEMENT (Fliff Browser Profiles)
  // =============================================

  getAllProfiles() {
    return Object.entries(this.data.profiles).map(([name, data]) => ({
      name,
      ...data,
      assignedTo: this.getProfileAssignee(name)
    }));
  }

  getProfile(profileName) {
    const profile = this.data.profiles[profileName];
    if (!profile) return null;
    
    return {
      name: profileName,
      ...profile,
      assignedTo: this.getProfileAssignee(profileName)
    };
  }

  // Register a profile (called when profile starts running)
  registerProfile(profileName, settings = {}) {
    this.data.profiles[profileName] = {
      ...settings,
      registeredAt: new Date().toISOString(),
      isRunning: true
    };
    this.save();
    return { success: true };
  }

  // Update profile status
  updateProfileStatus(profileName, isRunning) {
    if (this.data.profiles[profileName]) {
      this.data.profiles[profileName].isRunning = isRunning;
      this.save();
    }
  }

  // Get which user a profile is assigned to
  getProfileAssignee(profileName) {
    for (const [username, assignment] of Object.entries(this.data.assignments)) {
      if (assignment.profiles && assignment.profiles.includes(profileName)) {
        return username;
      }
    }
    return null; // Unassigned
  }

  // Get all unassigned profiles
  getUnassignedProfiles() {
    return Object.keys(this.data.profiles).filter(name => !this.getProfileAssignee(name));
  }

  // =============================================
  // ASSIGNMENT MANAGEMENT
  // =============================================

  getUserProfiles(username) {
    const assignment = this.data.assignments[username];
    return assignment ? assignment.profiles || [] : [];
  }

  getUserMainProfile(username) {
    const assignment = this.data.assignments[username];
    return assignment ? assignment.mainProfile : null;
  }

  // Assign profile to user
  assignProfile(username, profileName) {
    if (!this.data.users[username]) {
      return { success: false, error: 'User not found' };
    }

    // Initialize assignment if needed
    if (!this.data.assignments[username]) {
      this.data.assignments[username] = { profiles: [], mainProfile: null };
    }

    // Check if already assigned to someone else
    const currentAssignee = this.getProfileAssignee(profileName);
    if (currentAssignee && currentAssignee !== username) {
      // Remove from previous user first
      this.unassignProfile(currentAssignee, profileName);
    }

    // Add to user's profiles
    if (!this.data.assignments[username].profiles.includes(profileName)) {
      this.data.assignments[username].profiles.push(profileName);
    }

    // Set as main if user has no main profile
    if (!this.data.assignments[username].mainProfile) {
      this.data.assignments[username].mainProfile = profileName;
    }

    this.save();
    return { success: true };
  }

  // Unassign profile from user
  unassignProfile(username, profileName) {
    if (!this.data.assignments[username]) {
      return { success: false, error: 'User not found' };
    }

    const profiles = this.data.assignments[username].profiles;
    const index = profiles.indexOf(profileName);
    
    if (index > -1) {
      profiles.splice(index, 1);
      
      // If this was the main profile, pick another one
      if (this.data.assignments[username].mainProfile === profileName) {
        this.data.assignments[username].mainProfile = profiles[0] || null;
      }
      
      this.save();
    }

    return { success: true };
  }

  // Set main profile for user
  setMainProfile(username, profileName) {
    if (!this.data.assignments[username]) {
      return { success: false, error: 'User not found' };
    }

    // Verify user has access to this profile
    if (!this.data.assignments[username].profiles.includes(profileName)) {
      return { success: false, error: 'User does not have access to this profile' };
    }

    this.data.assignments[username].mainProfile = profileName;
    this.save();
    return { success: true };
  }

  // Check if user has access to profile
  hasAccess(username, profileName) {
    // Admin has access to all
    if (this.isAdmin(username)) return true;
    
    const profiles = this.getUserProfiles(username);
    return profiles.includes(profileName);
  }

  // =============================================
  // BULK OPERATIONS
  // =============================================

  // Assign multiple profiles to user
  assignMultipleProfiles(username, profileNames, mainProfile = null) {
    if (!this.data.users[username]) {
      return { success: false, error: 'User not found' };
    }

    for (const profileName of profileNames) {
      this.assignProfile(username, profileName);
    }

    if (mainProfile && profileNames.includes(mainProfile)) {
      this.setMainProfile(username, mainProfile);
    }

    return { success: true, user: this.getUser(username) };
  }

  // Get dashboard data for a specific user
  getUserDashboardData(username) {
    const user = this.getUser(username);
    if (!user) return null;

    return {
      user: {
        username: user.username,
        displayName: user.displayName,
        role: user.role
      },
      profiles: user.assignedProfiles,
      mainProfile: user.mainProfile,
      profileCount: user.assignedProfiles.length
    };
  }

  // Get admin overview
  getAdminOverview() {
    const users = this.getAllUsers();
    const profiles = this.getAllProfiles();
    const unassigned = this.getUnassignedProfiles();

    return {
      totalUsers: users.length,
      totalProfiles: profiles.length,
      unassignedProfiles: unassigned.length,
      users: users,
      profiles: profiles,
      unassignedProfileNames: unassigned
    };
  }

  // Sync profiles from running fliffClients
  syncRunningProfiles(fliffClients) {
    const runningProfiles = Array.from(fliffClients.keys());
    
    // Register any new profiles
    for (const name of runningProfiles) {
      if (!this.data.profiles[name]) {
        this.registerProfile(name, {});
      } else {
        this.data.profiles[name].isRunning = true;
      }
    }

    // Mark non-running profiles
    for (const name of Object.keys(this.data.profiles)) {
      if (!runningProfiles.includes(name)) {
        this.data.profiles[name].isRunning = false;
      }
    }

    this.save();
    return { synced: runningProfiles.length };
  }
}

module.exports = UserManager;

