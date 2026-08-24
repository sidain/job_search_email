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


  return (    
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: 'sans-serif' }}>

      {/* 👈 Left Sidebar (1/3 Width) */}
      <div style={{ 
        flex: '1', 
        borderRight: '1px solid #e0e0e0', 
        padding: '1rem', 
        backgroundColor: '#f9f9f9',
        overflowY: 'auto',
        maxHeight: '100vh'
      }}>

        <h2 style={{ color: '#333', margin: '5px 5px 20px 5px' }}>💼 Job Listings ({jobs.length})</h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {jobs.map((job) => {

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
                  onClick={() => handleOpenDeleteModal(job._id)}>
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
                    <div>MsgId {job.message_id}</div>
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
                  <span><strong>Platform:</strong> {job.platform|| 'N/A'}</span>
                  
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
              <button onClick={() => handleOpenDeleteModal(selectedJob._id)}>
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

    </div>
  );
}
            
export default App;