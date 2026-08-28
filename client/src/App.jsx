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
    const [sortBy, setSortBy] = useState(localStorage.getItem('sortBy') || 'date-desc');
    const [statusFilter, setStatusFilter] = useState(localStorage.getItem('statusFilter') || 'not_applied');
    const [searchTerm, setSearchTerm] = useState(localStorage.getItem('searchTerm') || '');
    const [remoteFilter, setRemoteFilter] = useState(localStorage.getItem('remoteFilter') || 'all');
    const [platformFilter, setPlatformFilter] = useState(localStorage.getItem('platformFilter') || 'all');
    const [usEligibleFilter, setUsEligibleFilter] = useState(localStorage.getItem('usEligibleFilter') || 'all');

    useEffect(() => {
        localStorage.setItem('searchTerm', searchTerm);
    }, [searchTerm]);

    useEffect(() => {
        localStorage.setItem('remoteFilter', remoteFilter);
    }, [remoteFilter]);

    useEffect(() => {
        localStorage.setItem('sortBy', sortBy);
    }, [sortBy]);

    useEffect(() => {
        localStorage.setItem('setPlatformFilter', setPlatformFilter);
    }, [setPlatformFilter]);

    useEffect(() => {
        localStorage.setItem('usEligibleFilter', usEligibleFilter);
    }, [usEligibleFilter]);

    useEffect(() => {
        localStorage.setItem('statusFilter', statusFilter);
    }, [statusFilter]);



    const handleReset = () => {
        setSearchTerm('');
        localStorage.removeItem('searchTerm');

        setRemoteFilter('all');
        localStorage.removeItem('remoteFilter');

        setSortBy( 'date-desc'); // Reset sortBy to 'all'
        localStorage.removeItem('sortBy');
        
        setPlatformFilter('all');
        localStorage.removeItem('platformFilter');

        setUsEligibleFilter('all');
        localStorage.removeItem('usEligibleFilter');

        setStatusFilter('all');
        localStorage.removeItem('statusFilter');
    };

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
    if (p.includes('handshake')) return 'rgb(255, 230, 9)';       // 
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
    const jobToDelete = jobs.find((j) => j._id === jobId);

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
        console.error("Error deleting job listing:", error);
    }
};

const handlePatchJob = async (jobId, updatedFields) => {
  if (!jobId) return;

  try {
    // Send PATCH request instead of PUT
    const response = await axios.patch(`http://localhost:5000/api/jobs/${jobId}`, updatedFields);
    const updatedJobFromServer = response.data.job;

    // Update the local jobs state
    setJobs((prevJobs) =>
      prevJobs.map((job) => (job._id === jobId ? updatedJobFromServer : job))
    );

    // Update selected job if it matches
    if (selectedJob && selectedJob._id === jobId) {
      setSelectedJob(updatedJobFromServer);
    }
  } catch (error) {
    console.error('Error patching job listing:', error);
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

  // Filter and Sort combined
const filteredAndSortedJobs = [...jobs]
    .filter((job) => {
        // Search term matching
        const matchesSearch = 
        (job.title && job.title.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (job.company && job.company.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (job.platform && job.platform.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (job.location && job.location.toLowerCase().includes(searchTerm.toLowerCase()));

        // Remote Filter
        const matchesRemoteFilter =
            remoteFilter === 'all' ||
            (remoteFilter === 'remote' && job.location.toLowerCase().includes('remote') ) ||
            (remoteFilter === 'onsite' && !job.location.toLowerCase().includes('remote') );

        // US Eligible Filter
        const matchesUsEligible =
            usEligibleFilter === 'all' ||
            ( usEligibleFilter === 'yes' && job.us_eligible) ||
            ( usEligibleFilter === 'no' && !job.us_eligible) ;

        // 🌐 Platform Filter
        const matchPlatformFilter = 
            platformFilter === 'all' ||
            (platformFilter !== 'all' && job.platform === platformFilter )

        
        // Status Filter
        const matchStatusFilter=
            statusFilter === "all" || 
            (statusFilter === "applied" && job.status === "Applied") || 
            (statusFilter === "not_applied" && job.status !== "Applied");


        return matchesSearch &&  matchesRemoteFilter &&  matchPlatformFilter && matchesUsEligible && matchStatusFilter ;
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

    // 📜 Job status data structure
    const jobStatuses = [
        { value: "all", label: "All" },
        { value: "applied", label: "Applied" },
        { value: "not_applied", label: "Not Applied" }
    ];


  if (loading) return <div className="p-8" >🔄 Loading job listings...</div>;
  if (error) return <div className="p-8 text-red-800">❌ {error}</div>;



  return (    
    <div className="flex min-h-screen font-sans">

      {/* 👈 Left Sidebar (1/3 Width) */}
       <div className="flex-1 border-r border-gray-200 bg-gray-50 overflow-y-auto max-h-screen relative">

       {/* 📌 Sticky Header Container */}
        <div className="flex flex-col gap-2 top-0 p-4 sticky bg-white z-10 shadow-md border-b border-gray-200">
        
        <h2 
            style={{ color: '#111827' }}
            className="text-[#111] font-bold text-[14px] m-0 mb-2">
            💼 Job Listings ({jobs.length})
        </h2>

        {/* 🔍 Search Input */}
        <input 
            type="text"
            placeholder="Search title, company, location..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full box-border outline-none border border-gray-300 rounded px-3 py-1.5 bg-white text-neutral-800 text-xs"
        />

        {/* 🎛️ Filter Controls Row */}
        <div className="flex gap-2">
            {/* Remote Filter */}
            <select 
                value={remoteFilter}
                onChange={(e) => setRemoteFilter(e.target.value)}
                className="flex-1 p-1 border border-gray-300 rounded bg-white text-gray-800 text-xs"
            >
                <option value="all">All Locations</option>
                <option value="remote">Remote Only</option>
                <option value="onsite">On-site / Hybrid</option>
            </select>

            {/* US Eligible Filter */}
            <select 
            value={usEligibleFilter}
            onChange={(e) => setUsEligibleFilter(e.target.value)}
            className="flex-1 p-1 border border-gray-300 rounded bg-white text-gray-800 text-xs"
            >
                <option value="all">US Eligible: All</option>
                <option value="yes">US Eligible: Yes</option>
                <option value="no">US Eligible: No</option>
            </select>

            
    </div>

    {/* 🎛️ Filter Controls Row */}
        <div className="flex gap-2">
            {/* 🌐 Platform Dropdown Filter */}
            <select 
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value)}
                className="p-1 border border-gray-300 rounded bg-white text-gray-800 text-xs w-36 min-w-0 truncate"
            >
                <option value="all">All Platforms ({jobs.length})</option>
                {uniquePlatforms.map((plat) => (
                <option key={plat} value={plat}>
                    {plat}
                </option>
                ))}
            </select>

            {/* 🌐 Status Dropdown Filter */}
            <select 
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="p-1 border border-gray-300 rounded bg-white text-gray-800 text-xs w-24 min-w-0 truncate"
            >
                <option value="all">All({jobs.length})</option>
                {jobStatuses.map((statusObj) => (
                <option key={statusObj.value} value={statusObj.value}>
                    {statusObj.label}
                </option>
                ))}
            </select>
        </div>

        {/* Floating Sort Controls */}
        <div className="flex items-center gap-4 text-xs pb-1">
            <label htmlFor="sort-select" className="font-bold text-gray-600">
                Sort by:
            </label>

          <select 
            id="sort-select"
            value={sortBy} 
            onChange={(e) => setSortBy(e.target.value)}
            className="flex-1 py-1 px-2 border rounded border-gray-300 bg-white text-xs text-neutral-800 cursor-pointer"
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

        <div className="self-end">
            <button className="cursor-pointer" onClick={handleReset}>Reset</button>
        </div>

      </div>

        <div className="flex flex-col gap-4 p-4">
          {filteredAndSortedJobs.map((job) => {

            const isSelected = selectedJob && selectedJob._id === job._id;
            
            return (
              <div 
                key={job._id} 
                onClick={() => setSelectedJob(job)} // Select job on click 🖱️
                className={`rounded-lg p-4 cursor-pointer transition-colors duration-200 text-xs text-left shadow-sm ${ isSelected ? 'border-2 border-blue-600 bg-blue-50' : 'border border-gray-200 bg-white hover:border-gray-300'}`}
            >

                <div className="flex items-start justify-between gap-2 mb-2">
                    

                    {/* 👈 Left side: Job ID and MsgId metadata */}
                    <div className="flex flex-col gap-1 text-[8px] text-gray-400 leading-tight">
                        <span className="text-[8px]">JobID: {job._id}</span>
                        <span
                            className="text-[8px] px-1.5 py-0.5 rounded inline-block w-fit"
                            style={{ backgroundColor: getMsgIdColor(job.message_id) }}
                        >
                            MsgId: {job.message_id || 'N/A'}
                        </span>
                    </div>

                    {/* 👉 Right side: Delete and Apply buttons grouped together */}
                    <div className="flex flex-col items-end gap-2 shrink-0">
                        <button 
                            onClick={(e) => { e.stopPropagation(); handleDeleteJob(job._id); }}
                            className="rounded text-xs bg-transparent cursor-pointer border-none text-gray-400 hover:text-red-600"
                        >
                            ❌
                        </button>


                        {job.status === 'Applied' ? (
                            <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                                Applied ✓
                            </span>
                        ) : (
                            <button 
                                onClick={(e) => { e.stopPropagation(); handlePatchJob(job._id, { status: 'Applied' }); }}
                                className="rounded text-xs bg-blue-600 text-white text-blue border border-emerald-200 px-2 py-0.5 hover:bg-emerald-100 cursor-pointer"
                            >
                                Apply
                            </button>
                        )}
                    </div>
                </div>


                <div className="text-center mb-2">
                    <h3 className="text-base font-semibold text-gray-900 mb-0.5 leading-snug">{job.title || 'Untitled Role'}</h3>
                    <div className="text-[10px] text-gray-400">{job.last_updated ? `Last Updated: ${new Date(job.last_updated).toLocaleDateString()}` : 'Last Updated: N/A'}</div>
                </div>

                <div className="text-gray-600 space-y-1.5">
                    <div><strong>Company:</strong> {job.company || 'N/A'}</div>

                    <div>
                        <strong>Platform:</strong>{' '}
                        <span 
                            style={{ color: getPlatformColor(job.platform) }}
                            className="font-bold"
                        >
                        {job.platform || 'N/A'}
                        </span>
                    </div>

                    <div className="flex justify-between gap-2">
                      <span><strong>Loc:</strong> {job.location || 'N/A'}</span>
                      <span><strong>Emp Type:</strong> {job.is_staffing_agency ? 'Staffing Agency' : 'Direct Hire'}</span>
                    </div>

                    <div className="flex justify-between gap-2">
                      <span><strong>US Eligible:</strong> {job.us_eligible ? 'Yes' : 'No'}</span>
                      <span><strong>Comp:</strong> {job.comp|| 'N/A'}</span>
                    </div>

                    <div className="text-center pt-1.5 mt-1 border-t border-gray-100">
                      <strong>Status:</strong> {job.status|| 'N/A'}
                    </div>
                </div>

              </div>
            );
          })}
        </div>
      </div>





      {/* 👉 Main Content Area (2/3 Width) */}
        <div className="flex flex-[2] flex-col p-8 overflow-y-auto max-h-screen">

        {selectedJob ? (
          <div className="flex flex-col h-full">
            {/* Listing details */}
            <div style={{ marginBottom: "6px" }}>
                <h1 
                    style = {{ fontSize: '28px', lineHeight: '1.5'  }}
                    className="font-bold  break-words mb-4"
                >
                    {selectedJob.title || 'Untitled Role'}
                </h1>
                    
                <button 
                    onClick={(e) => {e.stopPropagation(); handleDeleteJob(selectedJob._id);}}
                    className="mb-3 cursor-pointer bg-red-50 text-red-700 border border-red-200 rounded px-3 py-1.5 text-sm hover:bg-red-100 mb-2"
                >
                    Delete Job 🗑️
                </button>

                <hr className="border-[0.5px] border-gray-200 my-6" />
                <p className="text-[1.2rem] text-gray-800">
                    <strong>Company:</strong> {selectedJob.company || 'N/A'}
                </p>
              
                <p>
                    <strong>Location:</strong> {selectedJob.location || 'N/A'}
                </p>
                
                <p>
                    <strong>Compensation:</strong> {selectedJob.comp || 'Not specified'}
                </p>
                
                <p>
                    <strong>Platform:</strong> {selectedJob.platform || 'N/A'}
                </p>

              
            </div>

            <div className="flex flex-col gap-2.5 mt-4 mb-6 items-center">
                {/* 📧 View Source Email in Gmail */}
                {selectedJob.gmail_link && (
                    <div>
                        <a 
                        href={selectedJob.gmail_link} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        style={{ backgroundColor: '#ea4335', color: '#fff' }}
                        className="inline-block box-border text-center py-1.5 px-3 rounded no-underline font-bold text-[13px] w-40 mb-2"
                        >
                            Open in Gmail ✉️
                        </a>
                    </div>
                )}

                {/* Embedded URL Section */}
                {selectedJob.url && (
                <div>
                    <a 
                        href={selectedJob.url} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        style={{ backgroundColor: '#0066cc', color: '#fff' }}
                        className="inline-block box-border text-center py-1.5 px-3 rounded no-underline font-bold text-[13px] w-40 mb-2"
                    >
                        Open in new tab ↗
                    </a>
                </div>
                )}
            </div>

            <div className="border border-gray-200 rounded-lg overflow-hidden shadow-sm">
                {/* Job Details Section */}
                
                <iframe src={`${selectedJob.url}`} className="w-full h-screen block">
                </iframe>
            </div>

          </div>
        ) : (
          <p className="text-gray-400">Select a job from the list on the left to view details.</p>
        )}
      </div>

      {/* Confirmation Modal */}
        <ConfirmModal
            isOpen={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            onConfirm={handleConfirmDelete}
            title="Confirm Deletion"
            message="Are you sure you want to remove this job listing? It will no longer appear in your active list."
        />

      {/* 🪟 Undo Popup Banner */}
      {deletedJobData && (
        <div className="items-center text-white text-sm bg-[#333] fixed flex gap-4 z-[1000] py-3 px-5 rounded-lg left-1/2 -translate-x-1/2 bottom-5 shadow-lg">
          <span>Deleted "{deletedJobData.title}"</span>
          <button 
            onClick={handleUndoDelete}
            className="hover:bg-blue-700 bg-blue-600 text-white rounded cursor-pointer font-bold px-3 py-1.5 border-none"
          >
            Undo
          </button>
        </div>
      )}

    </div>
  );
}
            
export default App;