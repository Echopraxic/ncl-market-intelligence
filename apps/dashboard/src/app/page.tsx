export default function HomePage() {
  return (
    <main className='min-h-screen flex items-center justify-center'>
      <div className='text-center space-y-4'>
        <h1 className='text-4xl font-bold' style={{ color: '#0B1F3A' }}>
          NCL Market Intelligence Engine
        </h1>
        <p className='text-gray-500 text-lg'>
          Dashboard UI — Phase 3 (Weeks 11–12)
        </p>
        <div className='grid grid-cols-3 gap-4 mt-8 text-sm text-left'>
          <div className='bg-white rounded-lg p-4 shadow-sm border'>
            <p className='font-semibold text-gray-700'>Phase 1</p>
            <p className='text-green-600'>Foundation ✓</p>
          </div>
          <div className='bg-white rounded-lg p-4 shadow-sm border'>
            <p className='font-semibold text-gray-700'>Phase 2</p>
            <p className='text-gray-400'>Intelligence Layer</p>
          </div>
          <div className='bg-white rounded-lg p-4 shadow-sm border'>
            <p className='font-semibold text-gray-700'>Phase 3</p>
            <p className='text-gray-400'>Scoring & Dashboard</p>
          </div>
        </div>
      </div>
    </main>
  );
}
