import React, { useState, useEffect } from 'react';
import axios from 'axios';
import ConfirmModal from './components/ConfirmModal';

function App() {
    const [jobs, setJobs] = useState([]);
    const [selectedJob, setSelectedJob] = useState(null); // Tracks clicked job 🎯
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedJobId, setSelectedJobId] = useState(null);
    const [deletedJobData, setDeletedJobData] = useState(null);
    const [undoTimer, setUndoTimer] = useState(null);
    const [sortBy, setSortBy] = useState('date-desc');
    const [searchTerm, setSearchTerm] = useState('');
    const [remoteFilter, setRemoteFilter] = useState('all'); // 'all', 'remote', 'onsite'
    const [usEligibleFilter, setUsEligibleFilter] = useState('all'); // 'all', 'yes', 'no'
    const [platformFilter, setPlatformFilter] = useState('all'); // 'all' or specific platform


  const getMsgIdColor = (msgId) => {
    if(!msgId) return '#f0f0f0';
    let hash = 0;
    for(let i = 0; i < msgId.length; i++) {
        hash += msgId.charCodeAt(i) + ((hash << 5) - hash );
    }
    const hue = Math.abs( hash) % 360;
    return `hsl(${hue}, 70%, 85%)`;
  };


  const getPlatformColor = (platform) => {
    if (!platform) return '#333';
    const p = platform.toLowerCase();

    if (p.includes('linkedin')) return '#0a66c2';        // LinkedIn Blue
    if (p.includes('indeed')) return '#003a9b';          // Indeed Dark Blue
    if (p.includes('glassdoor')) return '#0caa41';       // Glassdoor Green
    if (p.includes('google') || p.includes('job alerts from google')) return '#ea4335'; // Google Red

    return '#555'; // Default fallback color
};


// 1. Open modal when user clicks delete icon on a job card
  const handleOpenDeleteModal = (jobId) => {
    setSelectedJobId(jobId);
    setIsModalOpen(true);
  };

  // 2. Execute deletion when confirmed inside modal
  const handleConfirmDelete = async () => {
    if (!selectedJobId) return;

    try {
      // API call to Express backend
      await axios.delete(`http://localhost:5000/api/jobs/${selectedJobId}`);

      // Update state to remove deleted job instantly
      setJobs((prevJobs) => prevJobs.filter((job) => job._id !== selectedJobId));

      // Close modal reset state
      setIsModalOpen(false);
      setSelectedJobId(null);
    } catch (error) {
      console.error('Error deleting job listing:', error);
    }
  };

  // Directly execute deletion without opening the confirm modal
  // const handleDeleteJob = async (jobId) => {
  //   if (!jobId) return;

  //   try {
  //     // API call to Express backend
  //     await axios.delete(`http://localhost:5000/api/jobs/${jobId}`);

  //     // Update state to remove deleted job instantly
  //     setJobs((prevJobs) => {
  //       const updatedJobs = prevJobs.filter((job) => job._id !== jobId);
        
  //       // If the currently selected job is the one being deleted, clear or shift selection
  //       if (selectedJob && selectedJob._id === jobId) {
  //         setSelectedJob(updatedJobs.length > 0 ? updatedJobs[0] : null);
  //       }

  //       return updatedJobs;
  //     });
  //   } catch (error) {
  //     console.error('Error deleting job listing:', error);
  //   }
  // };


const handleDeleteJob = async (jobId) => {
  if (!jobId) return;

  // Find the job object before removing it locally so we can restore it if "Undo" is clicked
  const jobToDelete = jobs.find(j => j._id === jobId);

  // Clear any existing active undo timer
  if (undoTimer) {
    clearTimeout(undoTimer);
  }

  try {
    // Perform soft delete request
    await axios.delete(`http://localhost:5000/api/jobs/${jobId}`);

    // Update local state to remove it visually
    setJobs((prevJobs) => {
      const updatedJobs = prevJobs.filter((job) => job._id !== jobId);
      if (selectedJob && selectedJob._id === jobId) {
        setSelectedJob(updatedJobs.length > 0 ? updatedJobs[0] : null);
      }
      return updatedJobs;
    });

    // Hold onto the deleted job for the undo window
    setDeletedJobData(jobToDelete);

    // Set a 60-second timeout to clear the undo option
    const timer = setTimeout(() => {
      setDeletedJobData(null);
      setUndoTimer(null);
    }, 60000);

    setUndoTimer(timer);

  } catch (error) {
    console.error('Error deleting job listing:', error);
  }
};

// Add the handleUndo function
const handleUndoDelete = async () => {
  if (!deletedJobData) return;

  if (undoTimer) {
    clearTimeout(undoTimer);
    setUndoTimer(null);
  }

  try {
    await axios.post(`http://localhost:5000/api/jobs/${deletedJobData._id}/undo`);

    // Put the job back into the list
    setJobs((prevJobs) => [deletedJobData, ...prevJobs]);
    setSelectedJob(deletedJobData);
    setDeletedJobData(null);
  } catch (error) {
    console.error('Error undoing deletion:', error);
  }
};


  useEffect(() => {
    // 1. Fetch data from our Node/Express API
    axios.get('http://localhost:5000/api/jobs')
      .then((response) => {
        setJobs(response.data);
        
        // Automatically select the first job if available
        if (response.data.length > 0) {
          setSelectedJob(response.data[0]);          
        }
        
        setLoading(false);
      })
      .catch((err) => {
        console.error('Error fetching jobs:', err);
        setError('Failed to load job listings.');
        setLoading(false);
      });
  }, []);

  if (loading) return <div style={{ padding: '2rem' }}>🔄 Loading job listings...</div>;
  if (error) return <div style={{ padding: '2rem', color: 'red' }}>❌ {error}</div>;



// Filter and Sort combined
const filteredAndSortedJobs = [...jobs]
    .filter((job) => {
        // Search term matching
        const matchesSearch = 
        (job.title && job.title.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (job.company && job.company.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (job.platform && job.platform.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (job.location && job.location.toLowerCase().includes(searchTerm.toLowerCase()));

        if (!matchesSearch) return false;

        // Remote Filter
        if (remoteFilter === 'remote') {
        const isRemote = job.location && job.location.toLowerCase().includes('remote');
        if (!isRemote) return false;
        } else if (remoteFilter === 'onsite') {
        const isRemote = job.location && job.location.toLowerCase().includes('remote');
        if (isRemote) return false;
        }

        // US Eligible Filter
        if (usEligibleFilter === 'yes' && !job.us_eligible) return false;
        if (usEligibleFilter === 'no' && job.us_eligible) return false;

        // 🌐 Platform Filter
        if (platformFilter !== 'all' && job.platform !== platformFilter) return false;

        return true;
    })
    .filter((job) => {
        // Search term matching (checks title, company, platform, location, or notes)
        const matchesSearch = 
        (job.title && job.title.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (job.company && job.company.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (job.platform && job.platform.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (job.location && job.location.toLowerCase().includes(searchTerm.toLowerCase()));

    if (!matchesSearch) return false;

    // Remote Filter
    if (remoteFilter === 'remote') {
      const isRemote = job.location && job.location.toLowerCase().includes('remote');
      if (!isRemote) return false;
    } else if (remoteFilter === 'onsite') {
      const isRemote = job.location && job.location.toLowerCase().includes('remote');
      if (isRemote) return false;
    }

    // US Eligible Filter
    if (usEligibleFilter === 'yes' && !job.us_eligible) return false;
    if (usEligibleFilter === 'no' && job.us_eligible) return false;

    return true;
  })
  .sort((a, b) => {
    switch (sortBy) {
      case 'date-desc':
        return new Date(b.date || 0) - new Date(a.date || 0);
      case 'date-asc':
        return new Date(a.date || 0) - new Date(b.date || 0);
      case 'company-asc':
        return (a.company || '').localeCompare(b.company || '');
      case 'company-desc':
        return (b.company || '').localeCompare(a.company || '');
      case 'platform-asc':
        return (a.platform || '').localeCompare(b.platform || '');
      case 'platform-desc':
        return (b.platform || '').localeCompare(a.platform || '');
      case 'status':
        return (a.status || '').localeCompare(b.status || '');
      default:
        return 0;
    }
  });

    // Extract unique platform options dynamically
    const uniquePlatforms = [...new Set(jobs.map(job => job.platform).filter(Boolean))].sort();



  return (    
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'sans-serif' }}>

      {/* 👈 Left Sidebar (1/3 Width) */}
      <div style={{ 
        flex: '1', 
        borderRight: '1px solid #e0e0e0', 
        backgroundColor: '#f9f9f9',
        overflowY: 'auto',
        maxHeight: '100vh',
        position: 'relative' // Needed for sticky positioning context
      }}>

       {/* 📌 Sticky Header Container */}
        <div style={{
        position: 'sticky',
        top: 0,
        backgroundColor: '#f9f9f9',
        padding: '1rem',
        borderBottom: '10px solid #00ffff',
        zIndex: 10,
        boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
        }}>

        <h2 style={{ color: '#333', margin: '0 0 10px 0' }}>
            💼 Job Listings ({jobs.length})
        </h2>

        {/* 🔍 Search Input */}
        <input 
            type="text"
            placeholder="Search title, company, location..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
            padding: '6px 10px',
            borderRadius: '4px',
            border: '1px solid #ccc',
            backgroundColor: '#fff', // 👈 Add explicit background color
            color: '#333',          // 👈 Add explicit text color
            fontSize: '12px',
            outline: 'none',
            width: '100%',
            boxSizing: 'border-box'
            }}
        />

        {/* 🎛️ Filter Controls Row */}
        <div style={{ display: 'flex', gap: '8px' }}>
            {/* Remote Filter */}
            <select 
            value={remoteFilter}
            onChange={(e) => setRemoteFilter(e.target.value)}
            style={{ flex: 1, padding: '4px', borderRadius: '4px', border: '1px solid #ccc', fontSize: '11px', color: '#333', backgroundColor: '#fff' }}
            >
                <option value="all">All Locations</option>
                <option value="remote">Remote Only</option>
                <option value="onsite">On-site / Hybrid</option>
            </select>

            {/* US Eligible Filter */}
            <select 
            value={usEligibleFilter}
            onChange={(e) => setUsEligibleFilter(e.target.value)}
            style={{ flex: 1, padding: '4px', borderRadius: '4px', border: '1px solid #ccc', fontSize: '11px', color: '#333', backgroundColor: '#fff' }}
            >
                <option value="all">US Eligible: All</option>
                <option value="yes">US Eligible: Yes</option>
                <option value="no">US Eligible: No</option>
            </select>

            {/* 🌐 Platform Dropdown Filter */}
            <select 
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value)}
                style={{ flex: '1 1 100%', padding: '4px', borderRadius: '4px', border: '1px solid #ccc', fontSize: '11px', color: '#333', backgroundColor: '#fff' }}
                >
                <option value="all">All Platforms ({jobs.length})</option>
                {uniquePlatforms.map((plat) => (
                <option key={plat} value={plat}>
                    {plat}
                </option>
                ))}
            </select>
    </div>

        {/* Floating Sort Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', paddingBottom: '8px' }}>
          <label htmlFor="sort-select" style={{ fontWeight: 'bold', color: '#555' }}>Sort by:</label>
          <select 
            id="sort-select"
            value={sortBy} 
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              padding: '4px 8px',
              borderRadius: '4px',
              border: '1px solid #ccc',
              backgroundColor: '#fff',
              color: '#333', // 👈 Add explicit text color
              fontSize: '12px',
              cursor: 'pointer',
              flex: 1
            }}
          >
            <option value="date-desc">Newest Date</option>
            <option value="date-asc">Oldest Date</option>
            <option value="company-asc">Company Name (A-Z)</option>
            <option value="company-desc">Company Name (Z-A)</option>
            <option value="platform-asc">Platform (A-Z)</option>
            <option value="platform-desc">Platform (Z-A)</option>
            <option value="status">Status (A-Z)</option>
          </select>
        </div>
      </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {filteredAndSortedJobs.map((job) => {

            const isSelected = selectedJob && selectedJob._id === job._id;
            
            return (
              <div 
                key={job._id} 
                onClick={() => setSelectedJob(job)} // Select job on click 🖱️

                style={{ 
                  border: isSelected ? '2px solid #0066cc' : '1px solid #ccc', 
                  borderRadius: '6px', 
                  padding: '1rem',
                  backgroundColor: isSelected ? '#e6f0ff' : '#fff',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                  fontSize: '12px',
                  textAlign: 'left',
                }}
              >

                {/* Change job._id to selectedJob._id */}
                <button style={{ 
                  'float':'right' , 
                  fontSize:'10px', 
                  border: 'none',
                  borderRadius:'4px',
                  cursor: 'pointer',
                  backgroundColor:'transparent'}} 
                  onClick={(e) => {e.stopPropagation(); handleDeleteJob(job._id);}}>
                    {/* Delete Job  ❌ */} ❌
                </button>
                <br />

                <h3 style={{ textAlign: 'center', margin: '0 0 0.5rem 0', fontSize: '16px' }}>
                  
                  <div style={{
                    fontSize: '10px',
                    fontWeight: 'bold',
                    lineHeight: 1,
                    marginBottom: '5px',
                  }}>
                    <div>JobID: {job._id}</div>


                    <div style={{
                      backgroundColor: getMsgIdColor(job.message_id),
                      padding: '2px 4px',
                      borderRadius: '4px',
                      display: 'inline-block',
                      marginTop: '2px'
                    }}>
                      MsgId: {job.message_id || 'N/A'}
                    </div>
                  </div>

                  <div style={{
                    lineHeight:1.1,
                  }}>
                    <div style={{ marginBottom: '5px' }}>{job.title || 'Untitled Role'}</div>
                    <div style={{fontSize:'10px',}}>{job.last_updated ? `Last Updated: ${new Date(job.last_updated).toLocaleDateString()}` : 'Last Updated: N/A'}</div>
                  </div>


                </h3>

                <p style={{ margin: 0, color: '#555',  }}>
                    <span><strong>Company:</strong> {job.company || 'N/A'}</span> <br />

                    <p style={{ margin: 0, color: '#555' }}>
                        <span><strong>Company:</strong> {job.company || 'N/A'}</span> <br />
                        <span>
                            <strong>Platform:</strong>{' '}
                            <span style={{ color: getPlatformColor(job.platform), fontWeight: 'bold' }}>
                            {job.platform || 'N/A'}
                            </span>
                        </span>
                    </p>
                </p>
                
                <p style={{ margin: 0, color: '#555',  }}>
                  <span style={{ float: 'left' }}><strong>Loc:</strong> {job.location || 'N/A'}</span>
                  <span style={{ float: 'right' }}><strong>Emp Type:</strong> {job.is_staffing_agency ? 'Staffing Agency' : 'Direct Hire'}</span> 
                  <br />
                  
                  <span style={{ float: 'left' }}><strong>US Eligible:</strong> {job.us_eligible ? 'Yes' : 'No'}</span>
                  <span style={{ float: 'right' }}><strong> Comp:</strong> {job.comp|| 'N/A'}</span> <br />
                </p>
                
            



                <p style={{ margin: 0, color: '#555', textAlign: 'center' }}>
                  <span><strong>Status:</strong> {job.status|| 'N/A'}</span>
                </p>

              </div>
            );
          })}
        </div>
      </div>





      {/* 👉 Main Content Area (2/3 Width) */}
      <div style={{ flex: '2', padding: '2rem', overflowY: 'auto', maxHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        {selectedJob ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Listing details */}
            <div>
              <h1 style={{ fontSize: '24px' }}>{selectedJob.title || 'Untitled Role'}</h1>

              {/* Change job._id to selectedJob._id */}
              {/* <button onClick={() => handleOpenDeleteModal(selectedJob._id)}> */}
              <button onClick={(e) => {e.stopPropagation(); handleDeleteJob(selectedJob._id);}}>
                Delete Job 🗑️
              </button>

              <p style={{ fontSize: '1.2rem', color: '#333' }}>
                <strong>Company:</strong> {selectedJob.company || 'N/A'}
              </p>
              <hr style={{ border: '0.5px solid #eee', margin: '1.5rem 0' }} />
              
              <p><strong>Location:</strong> {selectedJob.location || 'N/A'}</p>
              <p><strong>Compensation:</strong> {selectedJob.comp || 'Not specified'}</p>
              <p><strong>Platform:</strong> {selectedJob.platform || 'N/A'}</p>

              {/* Confirmation Modal */}
              <ConfirmModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onConfirm={handleConfirmDelete}
                title="Confirm Deletion"
                message="Are you sure you want to remove this job listing? It will no longer appear in your active list."
              />
            </div>

            {/* Embedded URL Section */}
            {selectedJob.url && (
              <div style={{ marginTop: '1.5rem', flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: '1rem' }}>
                  <a 
                    href={selectedJob.url} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    style={{ 
                      display: 'inline-block',
                      backgroundColor: '#0066cc',
                      color: '#fff',
                      padding: '0.5rem 1rem',
                      borderRadius: '5px',
                      textDecoration: 'none',
                      fontWeight: 'bold',
                      fontSize: '14px'
                    }}
                  >
                    Open in new tab ↗
                  </a>
                </div>

                {/* 📧 View Source Email in Gmail */}
                {selectedJob.gmail_link && (
                <div style={{ marginTop: '1rem' }}>
                    <a 
                    href={selectedJob.gmail_link} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    style={{ 
                        display: 'inline-block',
                        backgroundColor: '#ea4335', // Google Red color theme
                        color: '#fff',
                        padding: '0.5rem 1rem',
                        borderRadius: '5px',
                        textDecoration: 'none',
                        fontWeight: 'bold',
                        fontSize: '14px',
                        marginRight: '10px'
                    }}
                    >
                    Open in Gmail ✉️
                    </a>
                </div>
                )}

                {/* 🖼️ Iframe preview */}
                {/* <iframe 
                  src={selectedJob.url} 
                  title={`Job posting for ${selectedJob.title}`}
                  style={{
                    width: '100%',
                    height: '600px',
                    border: '1px solid #ddd',
                    borderRadius: '8px'
                  }}
                /> */}


                {/* <iframe 
                  src={`http://localhost:5000/api/proxy-job?url=${encodeURIComponent(selectedJob.url)}`}
                  title="Job Preview"
                  style={{ width: '100%', height: '600px', border: '1px solid #ccc' }}
                /> */}
              </div>
            )}
          </div>
        ) : (
          <p style={{ color: '#888' }}>Select a job from the list on the left to view details.</p>
        )}
      </div>

      {/* 🪟 Undo Popup Banner */}
      {deletedJobData && (
        <div style={{
          position: 'fixed',
          bottom: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: '#333',
          color: '#fff',
          padding: '12px 20px',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          gap: '15px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          zIndex: 1000,
          fontSize: '14px'
        }}>
          <span>Deleted "{deletedJobData.title}"</span>
          <button 
            onClick={handleUndoDelete}
            style={{
              backgroundColor: '#0066cc',
              color: '#fff',
              border: 'none',
              padding: '6px 12px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
          >
            Undo
          </button>
        </div>
      )}

    </div>
  );
}
            
export default App;